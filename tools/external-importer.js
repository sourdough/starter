/*
external-importer.js

fetch ES module dependencies from a CDN, sanitize, rewrite bare specifiers
to local relative paths, and save static copies -- no npm, no node, no build
toolchain required on the consuming side.

USAGE (see https://docs.deno.com/ for setup):

deno run --allow-env --allow-read=./ --allow-write=./path/to/libs/ \
		--allow-net='cdn.jsdelivr.net' ./external-importer.js \
		-file=./external-dependencies.js -dump=./path/to/libs/

by default the script is a DRY RUN: it shows config and what it would fetch,
then exits. add --write to actually fetch and save files.

MODES:
	(default)   dry run -- show config, list queued URLs, exit
	--write     fetch, sanitize, rewrite imports, save files
	--versions  show parsed version info for all queued URLs, exit
	--outdated  check queued URLs against latest available on CDN, exit
	--help      show this message, exit

OPTIONS:
	-file=PATH      js file exporting a dependencies array of CDN URLs
	-dump=PATH      destination directory for saved files
	-max=N          max concurrent fetches (default: 5)
	-verbose=BOOL   extra logging
	--write         execute: fetch and save (default is dry run)
	--versions      show version summary
	--outdated      check for newer versions
	--help          show help

DEPENDENCY FILE FORMAT (path/to/external-dependencies.js):
	export const dependencies = [
		'https://cdn.jsdelivr.net/npm/lit@3.0.0/index.js/+esm',
		'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/async-append.js/+esm',
	];

SANITIZATION (applied to all .js files before saving):
	- strips C0/C1 control characters (except tab, LF, CR)
	- strips bidi override/isolate characters (trojan source attack class)
	- strips zero-width characters and UTF-8 BOM
	- normalizes line endings to LF
	- strips trailing whitespace per line
	- collapses 3+ consecutive blank lines to 1
	- converts space indentation to tabs (auto-detects unit size)
	- strips sourceMappingURL references (external resource, no value in vendored copy)
	- warns on: eval, new Function, debugger, document.write, setTimeout/setInterval
		with string argument, suspicious base64 blobs (with file:line context)

TODOs:
	- add feature: read package.json and emit dependency URL list for a CDN
	- add feature: per-file integrity reporting (unpkg ?meta .integrity field)
	- improve: handle non-jsdelivr CDN URL patterns more robustly
*/

import * as paf from 'jsr:@std/path/posix';
import * as fs from 'jsr:@std/fs';
import { args, symbols } from './args.js';

const config = {
	verbose:  false,
	max:      5,
	file:     './external-dependencies.js',
	dump:     './libs/',
	write:    false,
	versions: false,
	outdated: false,
	// TODO: package: '' -- read package.json, emit CDN url list
};

function printHelp(config){
	const opts = Object.entries(config)
		.map(([k, v]) => `-${ k }='${ v }' (${ typeof v })`)
		.join('\n\t');
	console.log(`
external-importer -- fetch ES module CDN dependencies as local static assets

usage:
	deno run --allow-env --allow-read=./ --allow-write=DUMP --allow-net=CDN_HOST \\
		./external-importer.js -file=DEPS -dump=DUMP [options]

this is a DRY RUN by default. add --write to actually fetch and save files.

options:
		${ opts }

		--write     execute (fetch + save); without this, reports only
		--versions  show version summary and exit
		--outdated  check for newer versions and exit
		--help      show this message and exit
`);
}


// ─── version utilities ───────────────────────────────────────────────────────

// [1,2,3] sort comparator: >0 = a newer, <0 = b newer, 0 = same
function versionDiff(a, b){
	if(!a || !b) return 0;
	for(let i = 0; i < 3; i++){
		const d = a[i] - b[i];
		if(d !== 0) return d;
	}
	return 0;
}

function parseVersion(semver = ''){
	return semver.split('.').map(n => Number(n) || 0);
}

/*
normalizeCdnPathname(url) -> string

extracts and normalizes the path portion of a CDN URL, stripping CDN-specific
decorators that vary by host:
 - query strings and fragments  (?module, #hash)
 - jsdelivr /npm/ prefix        /npm/lit@3.0.0 -> /lit@3.0.0
 - jsdelivr /+esm suffix        /index.js/+esm -> /index.js
 - non-path-safe characters     replaced with '_' (preserves @, /, ., -)

pure function, no throws.
*/
function normalizeCdnPathname(url){
	return url.pathname
		.replace(/[?#].*$/, '')
		.replace(/^\/npm\//, '/')
		.replace(/\/\+esm$/, '')
		.replace(/[^@/a-z0-9._-]/gi, '_');
}

/*
parseCdnPathname(pathname) -> { name, version, rest } | null

parses a normalized CDN pathname of the form /name@1.2.3/rest or
/@scope/name@1.2.3/rest into its components. returns null (not throw) if
the pathname does not match -- callers decide how to handle unrecognized patterns.
*/
function parseCdnPathname(pathname){
	const m = pathname.match(/^\/(.+)@_?([0-9]+\.[0-9]+\.[0-9]+)(.*)$/i);
	if(!m) return null;
	return { name: m[1], version: m[2], rest: m[3] };
}

// parse CDN href into structured parts -- used by --versions and --outdated modes
function parseHref(href){
	const url = new URL(href);
	const [, prefix = ''] = url.pathname.match(/^(\/(?:npm|gh)\b)/) ?? [];
	const [, suffix = ''] = url.pathname.match(/(\/\+esm)$/) ?? [];
	const pathname = normalizeCdnPathname(url);
	const parsed = parseCdnPathname(pathname);
	const { name = '', version = '', rest: path = '' } = parsed ?? {};
	const base = url.origin + (
		version ? `${ prefix }/${ name }` : `${ prefix }${ pathname }`
	);

	return { url, href, pathname, name, version, path, prefix, suffix, base };
}

function parseHrefs(urls){
	return Array.from(urls).map(parseHref);
}

/*
urlToPath(url, wwwroot, relative) -> path-parts object | null

converts a CDN URL to the local output path parts used for writing and
rewriting import specifiers. returns null (not throw) if the URL does not
match the expected versioned CDN pattern -- callers handle gracefully.
*/

function urlToPath(url, wwwroot, relative){
	const pathname = normalizeCdnPathname(url);
	const parsed = parseCdnPathname(pathname);
	if(!parsed) return null;
	const { name, version, rest } = parsed;
	const unversioned = `./${ name }${ rest }`;
	const versioned   = `./${ name }/${ version }${ rest }`;
	const ext         = paf.extname(rest).toLowerCase();
	const www = '/' + paf.relative(
		wwwroot, paf.resolve(wwwroot, relative,
			ext.endsWith('.js') ? versioned : (unversioned + '.js')));
	const wwwbasename  = paf.basename(www);
	const wwwext       = paf.extname(www).toLowerCase();
	const wwwversioned = '/' + paf.relative(
		wwwroot, paf.resolve(wwwroot, relative, versioned)
	) + (ext === '' ? '/' + wwwbasename : '');
	const semver = parseVersion(version);

	return { unversioned, versioned, name, version, ext, wwwbasename, wwwext, www, wwwversioned, semver };
}


// ─── sanitize pipeline ───────────────────────────────────────────────────────

// detect space-indent unit; returns spaces-per-level or null (already tabs / no indent)
function detectIndent(text){
	let tabLines = 0, spaceLines = 0, minSpaces = Infinity;
	for(const line of text.split('\n')){
		if(!line.trim()) continue;
		if(line[0] === '\t'){
			tabLines++;
		}else if(line[0] === ' '){
			spaceLines++;
			const n = line.match(/^ +/)[0].length;
			if(n < minSpaces) minSpaces = n;
		}
	}
	if(tabLines >= spaceLines || !spaceLines || minSpaces === Infinity) return null;
	return minSpaces;
}

// convert N-space indentation to tabs, line by line
function spaceIndentToTabs(text, unit){
	const sp = ' '.repeat(unit);
	return text.split('\n').map(line => {
		let depth = 0;
		while(line.startsWith(sp, depth * unit)) depth++;
		return depth ? '\t'.repeat(depth) + line.slice(depth * unit) : line;
	}).join('\n');
}

/*
sanitize(text, label) -> { text: string, warnings: string[] }

pure transform -- no side effects, no I/O.

strips:
	- C0 control chars (except TAB 0x09, LF 0x0A, CR 0x0D)
	- C1 control chars (0x7F-0x9F)
	- bidi override/isolate chars: U+200F, U+202A-202E, U+2066-2069
		(these are the Trojan Source attack class -- they change how code reads
		visually vs how it executes; no legitimate use in vendored ES modules)
	- zero-width chars: U+200B-U+200D, U+FEFF (BOM)
	- soft hyphen U+00AD
	- sourceMappingURL directives (external reference, useless in vendored copy)

normalizes:
	- CRLF and lone CR -> LF
	- trailing whitespace per line
	- 3+ consecutive blank lines -> 1 blank line
	- space indentation -> tabs (auto-detected unit)
	- single trailing newline at EOF

preserves: all other Unicode including emoji, CJK, Latin-extended, etc.
	(these legitimately appear in string literals and comments in the wild)
*/
function sanitize(text, label){
	const warnings = [];
	let s = text;

	// 1. bidi override / isolate (trojan source) -- named first, high priority
	const bidiPattern = /[\u200F\u202A-\u202E\u2066-\u2069]/g;
	const bidiMatches = s.match(bidiPattern);
	if(bidiMatches){
		warnings.push(`${ label }: removed ${ bidiMatches.length } bidi override/isolate char(s) [trojan source risk]`);
		s = s.replace(bidiPattern, '');
	}

	// 2. zero-width chars and BOM
	const zwPattern = /[\u200B-\u200D\uFEFF]/g;
	const zwMatches = s.match(zwPattern);
	if(zwMatches){
		warnings.push(`${ label }: removed ${ zwMatches.length } zero-width/BOM char(s)`);
		s = s.replace(zwPattern, '');
	}

	// 3. soft hyphen
	s = s.replace(/\u00AD/g, '');

	// 4. C0 controls (except TAB, LF, CR) and C1 controls
	const ctrlPattern = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
	const ctrlMatches = s.match(ctrlPattern);
	if(ctrlMatches){
		warnings.push(`${ label }: removed ${ ctrlMatches.length } control character(s)`);
		s = s.replace(ctrlPattern, '');
	}

	// 5. sourceMappingURL -- external reference, no value in vendored copy
	const smCount = (s.match(/\/\/# sourceMappingURL=[^\n]*/g) || []).length;
	if(smCount){
		warnings.push(`${ label }: removed ${ smCount } sourceMappingURL directive(s)`);
		s = s.replace(/\/\/# sourceMappingURL=[^\n]*/g, '');
	}

	// 6. normalize line endings
	s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

	// 7. trailing whitespace per line
	s = s.replace(/[ \t]+$/gm, '');

	// 8. collapse 3+ consecutive blank lines -> 1
	s = s.replace(/\n{3,}/g, '\n\n');

	// 9. space indent -> tabs
	const unit = detectIndent(s);
	if(unit) s = spaceIndentToTabs(s, unit);

	// 10. single trailing newline
	s = s.replace(/\n*$/, '\n');

	return { text: s, warnings };
}


// ─── content analysis (warnings only, no transforms) ─────────────────────────

/*
analyzeContent(text, label) -> string[]

scans for patterns that are worth human review but are NOT automatically
stripped -- stripping them could break functionality. returns warning strings
with label:line context.

flagged:
	- eval(
	- new Function(
	- debugger
	- document.write(
	- setTimeout / setInterval with a string first argument (code execution)
	- suspicious base64-like blobs (unbroken strings > 200 chars)
	- other zero-argument dynamic execution patterns: Function() [, f.call, f.apply not flagged -- too noisy]
*/
function analyzeContent(text, label){
	const warnings = [];
	const lines = text.split('\n');

	// patterns that flag with line number + snippet
	const patterns = [
		{ re: /\beval\s*\(/,                          tag: 'eval'              },
		{ re: /\bnew\s+Function\s*\(/,                tag: 'new Function'      },
		{ re: /\bdebugger\b/,                         tag: 'debugger'          },
		{ re: /\bdocument\.write\s*\(/,               tag: 'document.write'    },
		// setTimeout/setInterval(string, ...) -- string arg means code execution
		{ re: /\bset(?:Timeout|Interval)\s*\(\s*['"``]/, tag: 'set*Interval/Timeout with string arg' },
	];

	for(let i = 0; i < lines.length; i++){
		const line = lines[i];
		for(const { re, tag } of patterns){
			if(re.test(line)){
				const snippet = line.trim().slice(0, 80);
				warnings.push(`${ label }:${ i + 1 } [${ tag }] ${ snippet }`);
			}
		}
	}

	// base64 blob detection -- scan whole text for long unbroken strings
	// threshold: 200+ non-whitespace chars in a row within a string literal
	// report truncated context, not the blob itself
	const blobRe = /["'`]([A-Za-z0-9+/=]{200,})["'`]/g;
	let m;
	while((m = blobRe.exec(text)) !== null){
		// find line number from offset
		const lineNum = text.slice(0, m.index).split('\n').length;
		const blobLen = m[1].length;
		const preview = m[1].slice(0, 40);
		warnings.push(
			`${ label }:${ lineNum } [blob] unbroken string ${ blobLen } chars: "${ preview }..."`
		);
	}

	return warnings;
}


// ─── import rewriter (pure) ───────────────────────────────────────────────────

/*
rewriteImports(text, resolvedUrl, originalUrl, wwwroot, relative, verbose)
	-> { output: string, discovered: string[] }

pure transform -- discovers all import/export specifiers, rewrites them to
local relative paths, returns discovered absolute URLs for the fetch queue.
does NOT write any files.
*/
function rewriteImports(text, resolvedUrl, originalUrl, wwwroot, relative, verbose){
	const discovered = [];
	const modulePattern = /((?:import|export)\s*(?:[^"'\n\r;]+\s*from\s*)?)["']([^"']+)['"]/g;

	const url1 = new URL(originalUrl);
	const url2 = new URL(resolvedUrl);
	const p1   = urlToPath(url1, wwwroot, relative);
	const p2   = urlToPath(url2, wwwroot, relative);
	if(!p2){
		console.warn(`rewriteImports: unrecognized URL pattern, passing through unchanged: ${ resolvedUrl }`);
		return { output: text, discovered: [] };
	}

	if(p2.ext !== '.js'){
		return { output: text, discovered };
	}

	const rewritten = text.replace(modulePattern, (all, first, modl) => {
		const _url = new URL(modl, resolvedUrl);
		// NOTE: dynamic import() expressions are not matched by modulePattern --
		// they don't use from "specifier" syntax. this is acceptable scope.
		const paths = urlToPath(_url, wwwroot, relative);
 
		if(/^https?:/.test(modl)){
			if(!paths){
				console.warn(`  rewrite ^http: unrecognized pattern, leaving as-is: ${ modl }`);
				return all;
			}
			const { www } = paths;
			discovered.push(modl);
			const local = paf.relative(paf.dirname(p2.www), www);
			if(verbose) console.warn(`  rewrite ^http ${ first }"${ local }" (in ${ resolvedUrl })`);
			return `${ first }"${ local }"`;

		}else if(modl.startsWith('.')){
			const modlurl = new URL(modl, url2);
			const modlpaths = urlToPath(modlurl, wwwroot, relative);
			const modlext = modlpaths?.ext ?? '';
			const wwwext = paths?.wwwext ?? '';
			if(!modlext && wwwext){
				modlurl.pathname += wwwext;
			}
			discovered.push(modlurl.href);
			let local = modl.replace(/\?.*$/, '');
			if(!paf.extname(local)) local += '.js';
			if(verbose) console.warn(`  rewrite ^.   ${ first }"${ local }" (in ${ resolvedUrl })`);
			return `${ first }"${ local }"`;

		}else if(modl.startsWith('/')){
			const _modl    = modl.replace(/^\/npm\//, '/').replace(/\?.*$/, '').replace(/\/\+esm$/, '');
			const modlurl  = new URL(modl, url2);
			const modlpaths = urlToPath(modlurl, wwwroot, relative);
			if(modlpaths && !modlpaths.ext){
				const { wwwbasename } = paths ?? modlpaths;
				let { pathname } = modlurl;
				const esm = '/+esm';
				let ending = '';
				if(pathname.endsWith(esm)){
					ending = esm;
					pathname = pathname.slice(0, -esm.length);
				}
				if(pathname.endsWith('/')) pathname = pathname.slice(0, -1);
				modlurl.pathname = `${ pathname }/${ wwwbasename }${ ending }`;
			}
			discovered.push(modlurl.href);
			if(!paths){
				console.warn(`  rewrite ^/: unrecognized pattern, leaving as-is: ${ modl }`);
				return all;
			}
			const { wwwversioned } = paths;
			const local = paf.relative(paf.dirname(p2.www), wwwversioned);
			if(verbose) console.warn(`  rewrite ^/   ${ first }"${ local }" (in ${ resolvedUrl })`);
			return `${ first }"${ local }"`;

		}else{
			if(verbose) console.warn(`  unknown specifier: ${ all } (in ${ resolvedUrl })`);
			return all;
		}
	});

	const output = `/* ${ resolvedUrl } */\n` + rewritten;
	return { output, discovered };
}


// ─── file writing ─────────────────────────────────────────────────────────────

function writeFile(path, content){
	fs.ensureDirSync(paf.dirname(path));
	Deno.writeTextFileSync(path, content);
}

/*
writeOutputFiles(p1, p2, output, relative, unver, verbose)

handles the three cases the original covered:
	1. redirect to different version (bare url -> forwarding stub + real file)
	2. no redirect, same version (write file + optional versioned redirect)
	3. unversioned stub pointing to most recent seen this run
*/
function writeOutputFiles(p1, p2, output, relative, unver, verbose){
	const hasExports = /\bexport\b/.test(output);
	const reexport   = (target) => hasExports ? `export * from "${ target }"` : `import "${ target }"`;
	const filesWritten = [];

	if(p1.unversioned !== p2.unversioned){
		// redirect case: bare reference resolves to a different package path
		if(p1.ext.endsWith('.js')){
			throw new Error(`unexpected: bare url has .js extension ${ p1.versioned }`);
		}
		const bareFile   = paf.resolve(relative, `${ p1.unversioned }.js`);
		const bareLocal  = './' + paf.relative(paf.dirname(p1.unversioned), p2.versioned);
		writeFile(bareFile, `/* ${ p1.unversioned } -> ${ p2.versioned } */\n${ reexport(bareLocal) };\n`);
		filesWritten.push(bareFile);

		const realFile = paf.resolve(relative, p2.versioned);
		writeFile(realFile, output);
		filesWritten.push(realFile);

	}else{
		// normal case
		const realFile = paf.resolve(relative, p2.versioned);
		writeFile(realFile, output);
		filesWritten.push(realFile);

		if(p2.versioned !== p1.versioned){
			// versioned redirect: p1 -> p2
			const redirectFile  = paf.resolve(relative, p1.versioned);
			const redirectLocal = './' + paf.relative(paf.dirname(p1.versioned), p2.versioned);
			writeFile(redirectFile, `/* ${ p1.versioned } -> ${ p2.versioned } */\n${ reexport(redirectLocal) };\n`);
			filesWritten.push(redirectFile);
		}

		// unversioned stub -- only overwrite if this is the newest version seen this run
		const prev = unver[p2.unversioned];
		const isMostRecent = !prev || versionDiff(p2.semver, prev) > 0;
		if(isMostRecent){
			unver[p2.unversioned] = p2.semver;
			const unvFile  = paf.resolve(relative, p2.unversioned);
			const unvLocal = './' + paf.relative(paf.dirname(p2.unversioned), p2.versioned);
			writeFile(unvFile, `/* -> ${ p2.versioned } */\n${ reexport(unvLocal) };\n`);
			filesWritten.push(unvFile);
		}
	}

	if(verbose) console.log(`  wrote ${ filesWritten.length } file(s): ${ filesWritten.join(', ') }`);
	return filesWritten;
}


// ─── fetch + process one URL ──────────────────────────────────────────────────

/*
processOne(text, resolvedUrl, originalUrl, wwwroot, relative, verbose)
	-> { output: string, discovered: string[], warnings: string[], analysis: string[] }

pure: sanitize -> analyze -> rewrite. no I/O.
*/
function processOne(text, resolvedUrl, originalUrl, wwwroot, relative, verbose){
	const label = resolvedUrl;
	const p2 = urlToPath(new URL(resolvedUrl), wwwroot, relative);

	if(p2.ext !== '.js'){
		// non-js: pass through, no sanitize/analyze
		return { output: text, discovered: [], warnings: [], analysis: [] };
	}

	const { text: sanitized, warnings } = sanitize(text, label);
	const analysis = analyzeContent(sanitized, label);
	const { output, discovered } = rewriteImports(
		sanitized, resolvedUrl, originalUrl, wwwroot, relative, verbose
	);

	return { output, discovered, warnings, analysis };
}


// ─── concurrent fetch scheduler ──────────────────────────────────────────────

/*
fetchAll(seedUrls, config, wwwroot, relative)
	-> { results: Map<url, {output,warnings,analysis,filesWritten}>, totals }

fetches all URLs in queue including discovered dependencies, respecting
config.max for concurrency. in dry-run mode (config.write=false) fetches
nothing, just returns the seed URL set.
*/
async function fetchAll(seedUrls, config, wwwroot, relative){
	const { verbose, max, write } = config;
	const queue      = new Set(seedUrls);
	const seen       = new Set();
	const results    = new Map();
	const unver      = {};	// tracks most recent version per unversioned name
	let   fetchCount = 0;

	async function fetchOne(url){
		fetchCount++;
		console.log(`${ fetchCount } fetch ${ url }`);
		const res  = await fetch(url);
		const text = await res.text();
		return { text, resolvedUrl: res.url };
	}

	async function processUrl(url){
		seen.add(url);
		let text, resolvedUrl;

		try{
			({ text, resolvedUrl } = await fetchOne(url));
			seen.add(resolvedUrl);	// also mark redirected url as seen
		}catch(err){
			console.error(`fetch error ${ url }:`, err);
			return;
		}

		const { output, discovered, warnings, analysis } =
			processOne(text, resolvedUrl, url, wwwroot, relative, verbose);

		// emit sanitize warnings immediately
		for(const w of warnings) console.warn(`[sanitize] ${ w }`);
		for(const w of analysis) console.warn(`[inspect]  ${ w }`);

		let filesWritten = [];
		if(write){
			try{
				const p1 = urlToPath(new URL(url), wwwroot, relative);
				const p2 = urlToPath(new URL(resolvedUrl), wwwroot, relative);
				if(p2.ext === '.js'){
					filesWritten = writeOutputFiles(p1, p2, output, relative, unver, verbose);
				}else if(p2.ext && output){
					const outPath = paf.resolve(config.wwwroot, relative, p2.versioned);
					writeFile(outPath, output);
					filesWritten = [outPath];
				}else{
					console.warn(`[skip] no extension, unsure what to do with ${ resolvedUrl }`);
				}
			}catch(err){
				console.error(`write error ${ url }:`, err);
			}
		}

		results.set(url, { output, warnings, analysis, filesWritten });

		// enqueue newly discovered dependencies
		for(const dep of discovered){
			if(!seen.has(dep) && !queue.has(dep)){
				queue.add(dep);
				if(verbose) console.warn(`  queued ${ dep }`);
			}
		}
	}

	// drain queue in batches of max
	async function drain(){
		const batch = [];
		for(const url of queue){
			if(batch.length >= max) break;
			if(!seen.has(url)){
				queue.delete(url);
				batch.push(processUrl(url));
			}
		}
		if(!batch.length) return;
		await Promise.all(batch);
		if(queue.size) await drain();
	}

	await drain();

	const totals = {
		urls:          results.size,
		filesWritten:  Array.from(results.values()).reduce((n, r) => n + r.filesWritten.length, 0),
		warnings:      Array.from(results.values()).reduce((n, r) => n + r.warnings.length, 0),
		analysis:      Array.from(results.values()).reduce((n, r) => n + r.analysis.length, 0),
	};

	return { results, totals };
}


// ─── mode: --versions ─────────────────────────────────────────────────────────

function runVersions(queue, verbose){
	const vers = new Map();
	for(const item of parseHrefs(queue)){
		const { href, name, version, path, base } = item;
		if(!name) console.warn(`ambiguous name for ${ href }`);
		let v = vers.get(name);
		if(!v){ v = { versions: new Set(), base, urls: [] }; vers.set(name, v); }
		v.versions.add(version);
		v.urls.push(href);
	}
	if(verbose){
		for(const [name, v] of vers){
			console.log(name, v.base, Array.from(v.versions).join(', '));
			for(const u of v.urls) console.log('  ', u);
		}
	}else{
		console.log(vers);
	}
}


// ─── mode: --outdated ─────────────────────────────────────────────────────────

async function runOutdated(queue, verbose){
	console.log(`checking ${ queue.size } URLs for newer versions...`);

	const vers = new Map();
	for(const item of parseHrefs(queue)){
		const { href, name, version, base } = item;
		let v = vers.get(name);
		if(!v){ v = { versions: new Set(), base, urls: [] }; vers.set(name, v); }
		v.versions.add(version);
		v.urls.push(href);
	}

	// fetch latest for each unique base once
	const latestCache = new Map();
	await Promise.allSettled(
		Array.from(vers.values()).map(async (v) => {
			if(latestCache.has(v.base)) return;
			try{
				const res = await fetch(v.base);
				let latestHref;
				if(res.redirected){
					latestHref = res.url;
				}else{
					const text = await res.text();
					const part = text.match(/[\s\S]Original file: ([^\s]+)/)?.[1] ?? res.url;
					latestHref = new URL(part, res.url).href;
				}
				latestCache.set(v.base, parseHref(latestHref).version);
			}catch(err){
				console.error(`fetch error checking latest for ${ v.base }:`, err);
				latestCache.set(v.base, null);
			}
		})
	);

	const toUpdate = [];
	for(const [name, v] of vers){
		const latest = latestCache.get(v.base);
		if(!latest) continue;
		const latestParsed = parseVersion(latest);
		const pinned = Array.from(v.versions).map(parseVersion);
		pinned.sort(versionDiff);
		const newest = pinned[pinned.length - 1];
		const isCurrent = versionDiff(latestParsed, newest) === 0;
		if(verbose){
			console.log({
				name,
				pinned: pinned.map(v => v.join('.')),
				latest,
				isCurrent,
			});
		}
		if(!isCurrent){
			toUpdate.push({ name, pinned: newest.join('.'), latest, urls: v.urls });
		}
	}

	if(toUpdate.length){
		console.log(`\nupdates available:`);
		for(const { name, pinned, latest, urls } of toUpdate){
			console.log(`  ${ name }: ${ pinned } -> ${ latest }`);
			for(const u of urls) console.log(`    ${ u }`);
		}
	}else{
		console.log(`everything looks current`);
	}
}


// ─── main ─────────────────────────────────────────────────────────────────────

const time = Date.now();
const pwd  = Deno.env.get('PWD') ?? Deno.cwd();
// NOTE: wwwroot set before args() so it's present but not a CLI-settable option
config.wwwroot = pwd;

// args() mutates config in place.
// printHelp passed as function so -help/-h invokes it without auto-exit --
// we handle exit in mode dispatch below alongside the other modes.
args(Deno.args, config, printHelp);

const dump     = paf.resolve(paf.resolve(config.wwwroot), config.dump);
const relative = './' + paf.relative(config.wwwroot, dump);

console.log(`config`, { cwd: Deno.cwd(), ...config });

// positional args after '--' sentinel are treated as additional URLs
// eg: external-importer.js -dump=./out -- https://cdn.jsdelivr.net/npm/lit@3.3.1/index.js/+esm
const positionals = config[symbols.positionals] ?? [];
const queue = new Set(positionals.filter(u => /^https?:/i.test(u)));

if(config.file){
	const file = paf.resolve(config.file);
	if(file.endsWith('.js')){
		await import(file)
			.then(mod => {
				if(!Array.isArray(mod.dependencies)){
					console.warn(`${ config.file }: expected export const dependencies = [...], got`, typeof mod.dependencies);
					return;
				}
				for(const url of mod.dependencies){
					if(url && url.startsWith('http')) queue.add(url);
				}
			})
			.catch(err => {
				console.warn(`could not load ${ config.file }:`, err);
			});
	}
}

if (import.meta.main) {
		// all your top-level startup logic here
		// config setup, loadDependencies(), dry run, Deno.exit(), etc.
	// mode dispatch
	// NOTE: symbols.help is set by args() when -help or -h is passed

	if(config[symbols.help] || !config.dump){
		printHelp(config);
		Deno.exit(0);
	}

	if(!queue.size){
		console.warn(`no URLs queued -- check -file or pass URLs as arguments`);
		printHelp(config);
		Deno.exit(1);
	}

	if(config.versions){
		runVersions(queue, config.verbose);
		Deno.exit(0);
	}

	if(config.outdated){
		await runOutdated(queue, config.verbose);
		Deno.exit(0);
	}

	// default: dry run unless --write

	if(!config.write){
		console.log(`
	DRY RUN -- ${ queue.size } URL(s) queued. no files will be fetched or written.

	to fetch and save, add --write:

	deno run --allow-env --allow-read=./ \\
		--allow-write=${ config.dump } \\
		--allow-net='cdn.jsdelivr.net' \\
		./external-importer.js \\
		-file=${ config.file } \\
		-dump=${ config.dump } \\
		--write

	queued URLs:`);
		let n = 0;
		for(const url of queue) console.log(`  ${ ++n }. ${ url }`);
		console.log(`
	other modes: --versions  --outdated  --help
	`);
		Deno.exit(0);
	}
}

// ─── exports (pure functions, importable by tests) ───────────────────────────
export {
	sanitize,
	analyzeContent,
	detectIndent,
	spaceIndentToTabs,
	rewriteImports,
	parseHref,
	parseHrefs,
	parseVersion,
	versionDiff,
	urlToPath,
	processOne,
	normalizeCdnPathname,
	parseCdnPathname
};

// --write: go fetch everything
const { results, totals } = await fetchAll(queue, config, config.wwwroot, relative);

console.log(`
done in ${ Date.now() - time }ms
	urls processed : ${ totals.urls }
	files written  : ${ totals.filesWritten }
	sanitize warns : ${ totals.warnings }
	inspect flags  : ${ totals.analysis }
`);
