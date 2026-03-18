/*
external-importer.js

fetch ES module dependencies from a CDN, sanitize, rewrite bare specifiers
to local relative paths, and save static copies -- no npm, no node, no build
toolchain required on the consuming side.

USAGE (see https://docs.deno.com/ for setup):

deno run -A ./external-importer.js --dump=../www/wildtype/ --write

deno run --allow-env --allow-read=./ --allow-write=./path/to/libs/ \
		--allow-net='cdn.jsdelivr.net' ./external-importer.js \
		-file=./external-dependencies.js -dump=./path/to/libs/

by default the script is a DRY RUN: it shows config and what it would fetch,
then exits. add --write to actually fetch and save files.

MODES:
	(default)   dry run -- show config, list queued URLs, exit
	--write     fetch, sanitize, rewrite imports, save files
	--audit     scan existing vendored files in -dump for disallowed codepoints
	            and [inspect] flags without re-fetching or modifying anything.
	            use after tightening UNICODE_ALLOWED_RANGES to check what existing
	            local copies would now fail. requires only --allow-read.
	--versions  show parsed version info for all queued URLs, exit
	--outdated  check queued URLs against latest available on CDN, exit
	--inspect   fetch each queued URL and report all non-ASCII codepoints and
	            [inspect] flag hits, without writing any files. produces the
	            same output as --audit but operates on incoming URLs rather
	            than already-written local files.
	--help      show this message, exit

OPTIONS:
	-file=PATH      js file exporting a dependencies array of CDN URLs
	-dump=PATH      destination directory for saved files (also the audit target)
	-max=N          max concurrent fetches (default: 5)
	-verbose=BOOL   extra logging
	--write         execute: fetch and save (default is dry run)
	--audit         scan -dump directory; read-only, no fetch, no write
	--strict        with --write: exit 1 if any [inspect] flags block a write
	                with --audit: exit 1 if any findings (disallowed chars or
	                inspect flags) are found. prints summary to stdout for CI.
	--force         write files even when [inspect] flags are present (eval, etc.)
	                mutually exclusive with --strict; --force takes precedence.
	--versions      show version summary
	--outdated      check for newer versions
	--inspect       fetch URLs, report non-ASCII inventory + inspect flags, no write
	--help          show help

DEPENDENCY FILE FORMAT (path/to/external-dependencies.js):
	export const dependencies = [
		'https://cdn.jsdelivr.net/npm/lit@3.0.0/index.js/+esm',
		'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/async-append.js/+esm',
	];

CONTENT TYPE HANDLING:
	js   (.js .mjs .cjs .ts)  -- full pipeline: sanitize + analyze + rewrite imports
	text (.css .html .htm .svg .json .txt .md .map)
	                           -- char-strip sanitize only (no indent conversion,
	                              no import rewrite). invisible-unicode and trojan
	                              source characters are stripped from all text assets.
	binary / unknown           -- passed through unchanged, no processing.

SANITIZATION:
	applied to all text assets (js + text types above).

	character stripping uses an ALLOWLIST: characters are removed unless they
	are explicitly in the permitted set (UNICODE_ALLOWED_RANGES). this is
	structurally safer than a blocklist -- unknown future attack classes are
	caught automatically because they are outside the allowed set, not because
	they were individually enumerated after the fact.

	stripped (anything outside UNICODE_ALLOWED_RANGES), including but not limited to:
	- C0/C1 control characters (except tab U+0009, LF U+000A, CR U+000D)
	- bidi override/isolate chars U+202A-202E, U+2066-2069, U+200F (Trojan Source)
	- zero-width chars U+200B-200D, soft hyphen U+00AD, BOM U+FEFF
	- variation selectors U+FE00-FE0F, U+E0100-E01EF (Glassworm invisible payload)
	- Unicode Tag block U+E0000-E007F (invisible, no legitimate source use)
	- anything else outside the explicitly listed allowed ranges
	each stripped codepoint is identified by address in the warning output so
	that legitimate characters can be added to UNICODE_ALLOWED_RANGES if needed.

	normalized (after stripping, all text types):
	- line endings -> LF
	- trailing whitespace per line stripped
	- 3+ consecutive blank lines -> 1
	- sourceMappingURL directives removed (external reference, useless vendored)

	js only (additional normalization):
	- space indentation -> tabs (auto-detects unit)

	js only ([inspect] flags -- block write unless --force):
	- eval, new Function, debugger, document.write
	- setTimeout/setInterval with string arg
	- suspicious base64 blobs (>200 chars)
	- variation selector decoder signatures (0xFE0x/0xE010x hex range literals)

SECURITY SCOPE:
	this tool sanitizes the files it *outputs* -- the vendored copies written
	to -dump/. the tool's own source files (this file, args.js, and any file
	in the consuming project) are outside the sanitization boundary. if the
	tool source itself is tampered with, the sanitization machinery does not
	protect anything. verify the tool's own source separately --
	e.g. git log / git diff against a known-good commit, or checksum comparison
	against a trusted copy. the guarantee this tool provides is: files written
	to -dump/ are clean. the tool that writes them is trusted by assumption.

WRITE BEHAVIOR:
	- [sanitize] removals: stripped, logged to stderr, file is written
	- [inspect] flags: BLOCK the write by default. these patterns cannot be
	  auto-stripped without potentially breaking functionality. require human
	  review before vendoring. add --force to write despite flags.
	- --strict: additionally exits 1 and prints a BLOCKED summary to stdout
	  so CI pipelines can capture and surface it.

LOCALIZATION FILE NOTE:
	UNICODE_ALLOWED_RANGES was calibrated for JS library source code, not for
	human-language text in translation or localization files. if you vendor
	.json, .html, or .txt files that contain translated strings in languages
	using Latin Extended Additional (U+1E00-U+1EFF) -- Vietnamese in particular,
	also Welsh, Yoruba, and others -- those characters will be stripped and the
	output file will be garbled.

	the tool will warn you: each stripped codepoint is reported by address.
	to fix: identify the Unicode block from the address, verify it is legitimate
	for your use, and add the range to UNICODE_ALLOWED_RANGES.

	example for Vietnamese support:
	  [0x1E00, 0x1EFF],  // Latin Extended Additional (Vietnamese, Welsh, etc.)

	if this tool is being used to vendor localization data rather than code
	libraries, audit the output carefully after the first run with any new
	language's files before treating the vendored copy as authoritative.

NO, out of scope:
	- NO package.json parsing
	- NO file integrity checking or reporting: seriously, how is it useful to check a hash of a compromised source let alone who knows how many source attributions and intermediaries?

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
	audit:    false,	// scan existing -dump files for violations; read-only, no fetch
	strict:   false,	// exit 1 if findings present (write: blocked writes; audit: any finding)
	force:    false,	// write despite [inspect] flags -- overrides strict; use with caution
	versions: false,
	outdated: false,
	inspect:  false,
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


// ─── content type classification ─────────────────────────────────────────────

/*
classifyExt(ext) -> 'js' | 'text' | 'binary'

determines how a fetched asset should be processed:
  'js'     -- full pipeline: sanitize (with indent conversion) + analyzeContent + rewriteImports
  'text'   -- sanitize only (char stripping, no indent conversion, no import rewrite)
  'binary' -- pass through unchanged; no text processing

the invisible-unicode / trojan source attack surface exists in any text asset,
not only .js files. CSS, HTML, JSON, SVG, etc. can all carry hidden characters
that survive into the served copy. sanitizing all text types closes that.
*/
function classifyExt(ext){
	if(['.js', '.mjs', '.cjs', '.ts'].includes(ext))
		return 'js';
	if(['.css', '.html', '.htm', '.svg', '.json', '.txt', '.md', '.map', '.xml', '.yaml', '.yml'].includes(ext))
		return 'text';
	return 'binary';
}


// ─── unicode allowlist ────────────────────────────────────────────────────────

/*
HOMOGLYPH LIMITATION:
	this tool cannot detect look-alike character substitution attacks. example:
	Cyrillic U+0430 'а' is pixel-identical to Latin U+0061 'a' in every common
	monospace font, but the JS runtime treats them as distinct identifiers.
	a library that exports 'vаlidate' (Cyrillic а) and 'validate' (Latin a) as
	separate bindings will pass all checks here -- both characters are in the
	allowlist for legitimate reasons (Cyrillic in comments, string constants,
	i18n data). stripping cannot fix this without blocking entire Unicode scripts.

	the [inspect] flags and --strict/--force review gate are the practical
	mitigation: they require a human to read the file before it is vendored.
	a reviewer looking at the raw source with codepoint-aware tools (e.g.
	`cat -v`, a hex editor, or an editor with Unicode inspection) can catch
	these. for higher assurance, an AST-based pass that flags non-ASCII
	characters appearing in identifier positions (not in string literals or
	comments) would surface these without false-positives on legitimate i18n
	content. that is not currently implemented.

UNICODE_ALLOWED_RANGES

The explicit set of Unicode codepoints permitted in vendored source files.
Everything outside this set is stripped by stripDisallowed() and reported.

Format: [lo, hi] inclusive ranges, or [cp] for single codepoints.

TO EXTEND: if a legitimate library triggers a stripping warning for a character
you need to preserve, look up the Unicode block it belongs to and add the
appropriate range here with a comment. Do not add ranges speculatively.

Current set covers the scripts and symbols most commonly found in real-world
open-source library code. Notably absent (and therefore stripped):
	U+007F          DEL
	U+0080-U+009F   C1 controls
	U+00AD          soft hyphen (invisible formatting)
	U+200B-U+200F   zero-width chars + direction marks
	U+2028-U+202F   line/para sep, bidi overrides (Trojan Source)
	U+2066-U+2069   bidi isolates (Trojan Source)
	U+0600-U+0605   Arabic Cf format characters (invisible, zero-width, no source use)
	U+FE00-U+FE0F   Variation Selectors 1-16 (Glassworm)
	U+E0000-U+E007F Tag block (invisible)
	U+E0100-U+E01EF Variation Selectors Supplement (Glassworm)
	all unassigned and private-use ranges not listed
*/
const UNICODE_ALLOWED_RANGES = [
	[0x0009, 0x0009],	// TAB
	[0x000A, 0x000A],	// LF
	[0x000D, 0x000D],	// CR
	[0x0020, 0x007E],	// printable ASCII
	[0x00A0, 0x00AC],	// Latin-1 Supplement (stops before soft hyphen)
	[0x00AE, 0x024F],	// Latin-1 Supplement (resumes after soft hyphen) + Latin Extended A/B
	[0x0250, 0x02AF],	// IPA Extensions
	[0x0370, 0x03FF],	// Greek and Coptic
	[0x0400, 0x04FF],	// Cyrillic
	[0x0500, 0x052F],	// Cyrillic Supplement
	[0x0590, 0x05FF],	// Hebrew
	// U+0600-U+0605 are Arabic Cf format characters (Arabic Number Sign, Sign Sanah,
	// Footnote Mark, etc.) -- invisible, zero-width, Unicode category Cf. structurally
	// the same attack class as the zero-width chars excluded above: they can be
	// embedded silently in string literals or identifiers with no visual indicator.
	// no legitimate JS source file requires them. Arabic letters begin at U+0606.
	[0x0606, 0x06FF],	// Arabic letters and marks (U+0600-0605 Cf format chars excluded)
	[0x2010, 0x2027],	// hyphens, dashes, quotation marks, misc punctuation
	[0x2030, 0x205E],	// per-mille, prime, misc (excludes line-sep and bidi at 2028-202F)
	[0x20A0, 0x20CF],	// currency symbols
	[0x2100, 0x27BF],	// letterlike, number forms, arrows, math, symbols, dingbats
	[0x3040, 0x30FF],	// Hiragana + Katakana
	[0x3400, 0x4DBF],	// CJK Extension A
	[0x4E00, 0x9FFF],	// CJK Unified Ideographs
	[0xAC00, 0xD7A3],	// Hangul Syllables
	[0xF900, 0xFAFF],	// CJK Compatibility Ideographs
	[0x1F300, 0x1FAFF],	// Emoji (common supplementary blocks)
];

/*
buildDisallowedPattern(ranges) -> RegExp

builds a compiled regex that matches any codepoint NOT in the provided ranges.
the `u` flag is required: it makes the engine treat supplementary codepoints
as single units rather than surrogate pairs, so the negated character class
works correctly across the full Unicode range including emoji and the dangerous
supplementary planes (Tag block, VS Supplement).

pure function, called once at module load. do not call at runtime.
*/
function buildDisallowedPattern(ranges){
	const inner = ranges.map(([lo, hi]) => {
		const fmt = cp => cp <= 0xFFFF
			? `\\u${ cp.toString(16).toUpperCase().padStart(4, '0') }`
			: `\\u{${ cp.toString(16).toUpperCase() }}`;
		return (hi !== undefined && hi !== lo) ? `${ fmt(lo) }-${ fmt(hi) }` : fmt(lo);
	}).join('');
	return new RegExp(`[^${ inner }]`, 'gu');
}

// compiled once at module load from UNICODE_ALLOWED_RANGES -- all character stripping runs through this
// do not mutate UNICODE_ALLOWED_RANGES after import -- this pattern will not reflect changes.
const UNICODE_DISALLOWED = buildDisallowedPattern(UNICODE_ALLOWED_RANGES);

/*
isAllowed(cp) -> boolean

returns true if codepoint cp is within any range in UNICODE_ALLOWED_RANGES.
used by inspectCodepoints to annotate whether a non-ASCII character survives
stripping or is removed. O(ranges) per call -- only used in inspect/audit
reporting paths, not in the hot stripping pass.
*/
function isAllowed(cp){
	return UNICODE_ALLOWED_RANGES.some(([lo, hi]) => cp >= lo && cp <= (hi ?? lo));
}

/*
inspectCodepoints(text, label) -> string[]

produces a human-readable inventory of every non-ASCII codepoint present in
text. each unique codepoint is listed once with:
  - its address (U+XXXX)
  - occurrence count
  - status: [allowed] = survives stripping; [STRIPPED] = outside allowlist
  - line number and trimmed line content of first occurrence

this is the review surface for homoglyph attacks and any other non-ASCII
anomaly. a reviewer can scan this output and immediately see:
  - whether Cyrillic/Greek characters appear in what look like identifiers
  - whether invisible characters are present that the stripper will remove
  - the exact line to inspect in the original source

note: [allowed] status means the character is in UNICODE_ALLOWED_RANGES and
will NOT be stripped. [STRIPPED] means it will be removed by sanitize().
homoglyph-risk characters (e.g. Cyrillic lookalikes) will show as [allowed] --
this output is a review aid, not an automated decision.

pure function, no I/O.
*/
function inspectCodepoints(text, label){
	const inventory = new Map();	// cp -> { count, firstLineNum, firstLine }
	const lines = text.split('\n');

	for(let i = 0; i < lines.length; i++){
		const line = lines[i];
		// for...of iterates by codepoint, handling surrogate pairs correctly
		for(const ch of line){
			const cp = ch.codePointAt(0);
			if(cp <= 0x007E) continue;	// skip ASCII
			if(!inventory.has(cp)){
				inventory.set(cp, { count: 0, firstLineNum: i + 1, firstLine: line.trim().slice(0, 80) });
			}
			inventory.get(cp).count++;
		}
	}

	if(!inventory.size) return [];

	const findings = [`${ label }: ${ inventory.size } non-ASCII codepoint type(s):`];
	for(const [cp, { count, firstLineNum, firstLine }] of [...inventory.entries()].sort(([a], [b]) => a - b)){
		const hex    = cp.toString(16).toUpperCase().padStart(cp > 0xFFFF ? 5 : 4, '0');
		const status = isAllowed(cp) ? 'allowed' : 'STRIPPED';
		findings.push(`  U+${ hex } x${ count } [${ status }] line ${ firstLineNum }: ${ firstLine }`);
	}
	return findings;
}

/*
stripDisallowed(text, label) -> { text: string, warnings: string[] }

pure transform. removes every codepoint not in UNICODE_ALLOWED_RANGES and
reports what was stripped: count + up to 10 unique codepoint addresses.

this is the allowlist enforcement layer. it replaces individual named
blocklist patterns (bidi, variation selectors, zero-width, C0/C1, etc.) with
a single pass that catches all of them and anything else outside the allowed
set, including attack classes not yet known at the time of writing.
*/
function stripDisallowed(text, label){
	const warnings = [];
	const found    = new Map();	// codepoint (number) -> count

	const cleaned = text.replace(UNICODE_DISALLOWED, ch => {
		const cp = ch.codePointAt(0);
		found.set(cp, (found.get(cp) ?? 0) + 1);
		return '';
	});

	if(found.size > 0){
		const total   = [...found.values()].reduce((a, b) => a + b, 0);
		const entries = [...found.entries()].sort(([a], [b]) => a - b);
		const listed  = entries.slice(0, 10)
			.map(([cp, n]) => `U+${ cp.toString(16).toUpperCase().padStart(4, '0') }${ n > 1 ? `×${ n }` : '' }`)
			.join(', ');
		const overflow = entries.length > 10 ? ` (+${ entries.length - 10 } more)` : '';
		warnings.push(
			`${ label }: stripped ${ total } disallowed codepoint(s): ${ listed }${ overflow }` +
			` [add to UNICODE_ALLOWED_RANGES if legitimate]`
		);
	}

	return { text: cleaned, warnings };
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
sanitize(text, label, options?) -> { text: string, warnings: string[] }

pure transform -- no side effects, no I/O.

options:
  convertIndent (default: true) -- convert space indentation to tabs.
    set false for non-JS text assets (CSS, JSON, etc.) where tab conversion
    would alter content semantics or break format expectations.

character stripping: delegates entirely to stripDisallowed(), which enforces
UNICODE_ALLOWED_RANGES. see stripDisallowed() for the full set of what is and
is not permitted. warnings from stripping identify each removed codepoint by
address so callers can decide whether to expand the allowlist.

normalization steps (applied after stripping):
  - sourceMappingURL directives removed
  - CRLF and lone CR -> LF
  - trailing whitespace per line
  - 3+ consecutive blank lines -> 1
  - space indentation -> tabs (JS only, see convertIndent option)
  - single trailing newline at EOF

preserves: all Unicode in UNICODE_ALLOWED_RANGES, including emoji, CJK,
Latin-extended, Cyrillic, Greek, Arabic, Hebrew, and common symbol blocks.
*/
function sanitize(text, label, { convertIndent = true } = {}){
	const warnings = [];
	let s = text;

	// 1. strip all codepoints outside the unicode allowlist.
	//    catches bidi overrides, variation selectors, zero-width chars, C0/C1
	//    controls, soft hyphen, Tag block, and any future invisible/dangerous
	//    codepoint not yet individually named -- all in one pass.
	const { text: stripped, warnings: stripWarnings } = stripDisallowed(s, label);
	s = stripped;
	warnings.push(...stripWarnings);

	// 2. sourceMappingURL -- external reference, no value in vendored copy
	const smCount = (s.match(/\/\/# sourceMappingURL=[^\n]*/g) || []).length;
	if(smCount){
		warnings.push(`${ label }: removed ${ smCount } sourceMappingURL directive(s)`);
		s = s.replace(/\/\/# sourceMappingURL=[^\n]*/g, '');
	}

	// 3. normalize line endings
	s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

	// 4. trailing whitespace per line
	s = s.replace(/[ \t]+$/gm, '');

	// 5. collapse 3+ consecutive blank lines -> 1
	s = s.replace(/\n{3,}/g, '\n\n');

	// 6. space indent -> tabs (JS only; skip for CSS/JSON/etc. to avoid semantic changes)
	if(convertIndent){
		const unit = detectIndent(s);
		if(unit) s = spaceIndentToTabs(s, unit);
	}

	// 7. single trailing newline
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
		// variation selector decoder signatures -- patterns that indicate code implementing
		// the invisible-payload decode-then-eval attack (Glassworm 2026 and variants).
		// covers hex literals, unicode escape sequences, and decimal equivalents for
		// VS1-16 (U+FE00-FE0F = decimal 65024-65039) and VS101-256 (U+E0100-E01EF =
		// decimal 917760-917999). note: computed derivations (e.g. 0xFD00 + offset)
		// are not caught here -- stripping the VS characters themselves via
		// UNICODE_ALLOWED_RANGES is the primary defence; this is a secondary signal.
		{ re: /0xFE0[0-9A-Fa-f]|0xE010[0-9A-Fa-f]|0xE01EF|\\uFE0[0-9A-Fa-f]|\\u\{E01[0-9A-Fa-f]{2}\}|6502[4-9]\b|6503\d\b|91776\d\b|9177[7-9]\d\b|917[89]\d\d\b/, tag: 'variation-selector range ref [decoder signature]' }
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

routes by content type:
  binary -- pass through unchanged
  text   -- sanitize (char stripping only, no indent conversion)
  js     -- sanitize (full, with indent conversion) + analyzeContent + rewriteImports
*/
function processOne(text, resolvedUrl, originalUrl, wwwroot, relative, verbose){
	const label = resolvedUrl;
	const p2  = urlToPath(new URL(resolvedUrl), wwwroot, relative);
	const ext  = p2?.ext ?? '';
	const kind = classifyExt(ext);

	if(kind === 'binary'){
		// no text processing for binary/unknown asset types
		return { output: text, discovered: [], warnings: [], analysis: [] };
	}

	// text and js: always strip invisible/dangerous unicode characters
	const isJs = kind === 'js';
	const { text: sanitized, warnings } = sanitize(text, label, { convertIndent: isJs });

	if(!isJs){
		// text assets: char-strip only, no import rewrite, no code analysis
		return { output: sanitized, discovered: [], warnings, analysis: [] };
	}

	// js: full pipeline
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

				// immune mode: analysis findings block writes by default.
				// these are patterns that cannot be auto-stripped without potentially
				// breaking functionality (eval, new Function, etc.). they require
				// human review. re-run with --force to write despite flags.
				if(analysis.length && !config.force){
					// always log to stderr so it appears in the terminal
					console.error(`[BLOCKED] ${ resolvedUrl }`);
					for(const w of analysis) console.error(`  ${ w }`);
					console.error(`  re-run with --force to override.`);
					// also emit structured stdout line for --strict / CI capture
					console.log(`[BLOCKED] ${ resolvedUrl } -- ${ analysis.length } inspect flag(s): ` +
						analysis.map(w => w.replace(/^[^[]+/, '')).join(' | '));
				}else{
					if(analysis.length && config.force){
						console.warn(`[force-write] ${ resolvedUrl } written despite ${ analysis.length } inspect flag(s)`);
					}
					if(p2.ext === '.js'){
						filesWritten = writeOutputFiles(p1, p2, output, relative, unver, verbose);
					}else if(p2.ext && output){
						const outPath = paf.resolve(config.wwwroot, relative, p2.versioned);
						writeFile(outPath, output);
						filesWritten = [outPath];
					}else{
						console.warn(`[skip] no extension, unsure what to do with ${ resolvedUrl }`);
					}
				}
			}catch(err){
				console.error(`write error ${ url }:`, err);
			}
		}

		results.set(url, { output, warnings, analysis, filesWritten, blocked: analysis.length > 0 && !config.force });

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
		blocked:       Array.from(results.values()).filter(r => r.blocked).length,
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

// ─── mode: --inspect ────────────────────────────────────────────────────────

/*
runInspect(seedUrls, config) -> { results, totals }

fetches each URL in the queue (following discovered dependencies, exactly as
--write does) and runs inspectCodepoints + analyzeContent on the raw fetched
text. does NOT sanitize, rewrite, or write any files.

purpose: pre-flight review of incoming dependencies before committing to
vendoring them. produces the same output format as --audit so the review
workflow is identical regardless of whether you are inspecting incoming URLs
or auditing already-written local files.

output:
  per-file codepoint inventory + inspect flags -> stdout (immediate)
  summary                                      -> stdout (at end)
  --strict exit 1 if any findings

results: Map<url, { codepoints: string[], analysis: string[], kind: string }>
totals:  { urls, findings, withCodepoints, withAnalysis }
*/
async function runInspect(seedUrls, config){
	const { verbose, max, strict } = config;
	const queue   = new Set(seedUrls);
	const seen    = new Set();
	const results = new Map();
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
			seen.add(resolvedUrl);
		}catch(err){
			console.error(`fetch error ${ url }:`, err);
			return;
		}

		const ext  = urlToPath(new URL(resolvedUrl), config.wwwroot, './')?.ext ?? '';
		const kind = classifyExt(ext);

		// full codepoint inventory (all text types) and flag analysis (js only)
		const codepoints = kind !== 'binary' ? inspectCodepoints(text, resolvedUrl) : [];
		const analysis   = kind === 'js'     ? analyzeContent(text, resolvedUrl)    : [];

		// follow discovered import dependencies, same as --write would
		const { discovered } = kind === 'js'
			? rewriteImports(text, resolvedUrl, url, config.wwwroot, './', verbose)
			: { discovered: [] };

		if(codepoints.length || analysis.length){
			console.log(`[inspect] ${ resolvedUrl }`);
			for(const w of codepoints) console.log(`  [codepoints] ${ w }`);
			for(const w of analysis)   console.log(`  [flag]       ${ w }`);
		}else if(verbose){
			console.log(`[inspect] ok  ${ resolvedUrl }`);
		}

		results.set(url, { codepoints, analysis, kind });

		for(const dep of discovered){
			if(!seen.has(dep) && !queue.has(dep)){
				queue.add(dep);
				if(verbose) console.warn(`  queued ${ dep }`);
			}
		}
	}

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

	const allResults   = Array.from(results.values());
	const withFindings = allResults.filter(r => r.codepoints.length || r.analysis.length);

	const totals = {
		urls:           results.size,
		findings:       withFindings.length,
		withCodepoints: allResults.filter(r => r.codepoints.length).length,
		withAnalysis:   allResults.filter(r => r.analysis.length).length,
	};

	console.log(`\n[inspect] complete\n\turls scanned   : ${ totals.urls }\n\twith findings  : ${ totals.findings }\n\t  non-ascii    : ${ totals.withCodepoints } file(s) contain non-ASCII codepoints\n\t  inspect flags: ${ totals.withAnalysis } file(s) contain patterns requiring review\n${ totals.findings === 0 ? '\tall files clean.' : '\tsee output above for details.' }\n`);

	if(strict && totals.findings){
		console.log(`[inspect] FAILED -- ${ totals.findings } file(s) with findings:`);
		for(const [url, r] of results){
			if(!r.codepoints.length && !r.analysis.length) continue;
			console.log(`  ${ url }`);
			for(const w of r.codepoints) console.log(`    [codepoints] ${ w }`);
			for(const w of r.analysis)   console.log(`    [flag]       ${ w }`);
		}
		console.log(`\n  exiting 1.`);
		Deno.exit(1);
	}

	return { results, totals };
}

// ─── mode: --audit ────────────────────────────────────────────────────────────

/*
runAudit(dumpDir, config) -> { results, totals }

walks dumpDir recursively, reads every file, and runs the same analysis that
--write would apply -- without modifying anything. purpose: retroactively check
existing vendored files against the current UNICODE_ALLOWED_RANGES and
analyzeContent rules, especially useful after the allowlist is tightened.

results: Map<filepath, { warnings: string[], analysis: string[], kind: string }>
totals:  { files, textFiles, findings, withWarnings, withAnalysis }

binary files are counted but not processed. text + js files are scanned.
findings = files with at least one warning or analysis hit.

outputs:
  per-file findings -> stderr (immediate, as each file is scanned)
  summary           -> stdout (at end, always)
  --strict exit 1   -> stdout AUDIT FAILED block, then Deno.exit(1)
*/
async function runAudit(dumpDir, config){
	const { verbose, strict } = config;
	const results = new Map();
	let fileCount = 0;

	// collect all file paths under dumpDir
	const paths = [];
	for await (const entry of fs.walk(dumpDir, { includeFiles: true, includeDirs: false })){
		paths.push(entry.path);
	}
	paths.sort();

	console.log(`[audit] scanning ${ paths.length } file(s) in ${ dumpDir }`);

	for(const filepath of paths){
		fileCount++;
		const ext  = paf.extname(filepath).toLowerCase();
		const kind = classifyExt(ext);
		const rel  = paf.relative(dumpDir, filepath);

		if(kind === 'binary'){
			if(verbose) console.log(`[audit] skip (binary)  ${ rel }`);
			results.set(filepath, { warnings: [], analysis: [], kind });
			continue;
		}

		let text;
		try{
			text = await Deno.readTextFile(filepath);
		}catch(err){
			console.error(`[audit] read error ${ rel }:`, err);
			results.set(filepath, { warnings: [], analysis: [], kind });
			continue;
		}

		// strip check: what would stripDisallowed remove?
		const { warnings } = stripDisallowed(text, rel);

		// inspect check: what would analyzeContent flag? (js only)
		const analysis = kind === 'js' ? analyzeContent(text, rel) : [];

		// codepoint inventory: all non-ASCII characters with line context.
		// [allowed] = survives stripping; [STRIPPED] = will be removed.
		// review [allowed] entries for homoglyph risk (Cyrillic/Greek lookalikes).
		const codepoints = inspectCodepoints(text, rel);

		if(warnings.length || analysis.length || codepoints.length){
			console.error(`[audit] ${ rel }`);
			for(const w of codepoints) console.error(`  [codepoints] ${ w }`);
			for(const w of warnings)   console.error(`  [disallowed] ${ w }`);
			for(const w of analysis)   console.error(`  [inspect]   ${ w }`);
		}else if(verbose){
			console.log(`[audit] ok  ${ rel }`);
		}

		results.set(filepath, { warnings, analysis, codepoints, kind });
	}

	const allResults  = Array.from(results.values());
	const textScanned = allResults.filter(r => r.kind !== 'binary');
	const withFindings = allResults.filter(r => r.warnings.length || r.analysis.length || r.codepoints.length);

	const totals = {
		files:          fileCount,
		textFiles:      textScanned.length,
		findings:       withFindings.length,
		withWarnings:   allResults.filter(r => r.warnings.length).length,
		withAnalysis:   allResults.filter(r => r.analysis.length).length,
		withCodepoints: allResults.filter(r => r.codepoints.length).length,
	};

	// always print summary to stdout so it's capturable
	console.log(`
[audit] complete
	files scanned  : ${ totals.files } (${ totals.textFiles } text, ${ totals.files - totals.textFiles } binary skipped)
	with findings  : ${ totals.findings }
	  non-ascii    : ${ totals.withCodepoints } file(s) contain non-ASCII codepoints (see [codepoints] above)
	  disallowed   : ${ totals.withWarnings } file(s) contain codepoints outside UNICODE_ALLOWED_RANGES
	  inspect flags: ${ totals.withAnalysis } file(s) contain patterns requiring review
${ totals.findings === 0 ? '\tall files clean.' : '\tsee stderr output above for details.' }
`);

	if(strict && totals.findings){
		// structured stdout block for CI log capture
		console.log(`[audit] FAILED -- ${ totals.findings } file(s) with findings:`);
		for(const [fp, r] of results){
			if(!r.warnings.length && !r.analysis.length && !r.codepoints.length) continue;
			const rel = paf.relative(dumpDir, fp);
			console.log(`  ${ rel }`);
			for(const w of r.codepoints) console.log(`    [codepoints] ${ w }`);
			for(const w of r.warnings)   console.log(`    [disallowed] ${ w }`);
			for(const w of r.analysis)   console.log(`    [inspect]   ${ w }`);
		}
		console.log(`\n  to resolve disallowed codepoint warnings: review each address and add`);
		console.log(`  the range to UNICODE_ALLOWED_RANGES if the character is legitimate.`);
		console.log(`  to resolve inspect flags: review the flagged patterns and re-vendor`);
		console.log(`  with --force if you have confirmed they are safe.`);
		console.log(`  exiting 1.`);
		Deno.exit(1);
	}

	return { results, totals };
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

	// --audit does not use the URL queue -- dispatch before the queue size check
	if(config.audit){
		await runAudit(dump, config);
		Deno.exit(0);	// runAudit calls Deno.exit(1) internally for --strict failures;
					// this line is only reached on a clean exit
	}

	// --inspect uses the URL queue but does not write.
	// dispatch after queue is populated so -file and positional URLs are included.
	// falls through the queue-empty check below so a missing queue is reported normally.
	if(config.inspect && queue.size){
		await runInspect(queue, config);
		Deno.exit(0);	// runInspect calls Deno.exit(1) internally for --strict failures
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
	inspectCodepoints,
	isAllowed,
	classifyExt,
	stripDisallowed,
	UNICODE_ALLOWED_RANGES,
	buildDisallowedPattern,
	detectIndent,
	spaceIndentToTabs,
	rewriteImports,
	parseHref,
	parseHrefs,
	parseVersion,
	versionDiff,
	urlToPath,
	processOne,
	runAudit,
	runInspect,
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
	blocked writes : ${ totals.blocked }${ totals.blocked ? '  (re-run with --force to override)' : '' }
`);

// --strict: exit non-zero if any files were blocked by [inspect] flags.
// emits a machine-readable summary to stdout before exiting so CI logs
// capture it alongside other console.log output. use with --write.
if(config.strict && totals.blocked){
	const blockedEntries = Array.from(results.entries())
		.filter(([, r]) => r.blocked);
	console.log(`\n[strict] ${ totals.blocked } file(s) blocked -- manual review required before vendoring:`);
	for(const [url, r] of blockedEntries){
		console.log(`  ${ url }`);
		for(const w of r.analysis) console.log(`    ${ w }`);
	}
	console.log(`\n  add --force to write despite these flags (not recommended without review).`);
	console.log(`  exiting 1.`);
	Deno.exit(1);
}
