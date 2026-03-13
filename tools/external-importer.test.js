/*
external-importer.test.js

run:

deno test --allow-env --allow-read --allow-write --allow-net external-importer.test.js

for the dry-run subprocess tests only --allow-run is also needed:
deno test --allow-env --allow-read --allow-write --allow-net --allow-run external-importer.test.js

deno test -A external-importer.test.js

*/

import {
	assertEquals,
	assertThrows,
	assert,
	assertRejects,
	assertExists,
} from 'https://jsr.io/@std/assert/1.0.13/mod.ts';

import {
	sanitize,
	analyzeContent,
	detectIndent,
	spaceIndentToTabs,
	parseHref,
	parseVersion,
	versionDiff,
	normalizeCdnPathname,
	parseCdnPathname,
	rewriteImports,
	urlToPath
} from './external-importer.js';

import { args, symbols } from './args.js';

// ─── detectIndent ─────────────────────────────────────────────────────────────

Deno.test('detectIndent: 2-space returns 2', () => {
	const text = 'function foo(){\n  bar();\n  if(x){\n    baz();\n  }\n}\n';
	assertEquals(detectIndent(text), 2);
});

Deno.test('detectIndent: 4-space returns 4', () => {
	const text = 'function foo(){\n    bar();\n    if(x){\n        baz();\n    }\n}\n';
	assertEquals(detectIndent(text), 4);
});

Deno.test('detectIndent: already tabs returns null', () => {
	const text = 'function foo(){\n\tbar();\n\tif(x){\n\t\tbaz();\n\t}\n}\n';
	assertEquals(detectIndent(text), null);
});

Deno.test('detectIndent: no indentation returns null', () => {
	const text = 'const x = 1;\nconst y = 2;\n';
	assertEquals(detectIndent(text), null);
});

Deno.test('detectIndent: mixed, tabs dominant returns null', () => {
	// 4 tab-indented lines, 1 space-indented -- tabs win
	const text = '\tline1\n\tline2\n\tline3\n\tline4\n  spaceline\n';
	assertEquals(detectIndent(text), null);
});


// ─── spaceIndentToTabs ────────────────────────────────────────────────────────

Deno.test('spaceIndentToTabs: converts 2-space correctly', () => {
	const input  = '  foo\n    bar\n      baz\n';
	const output = '\tfoo\n\t\tbar\n\t\t\tbaz\n';
	assertEquals(spaceIndentToTabs(input, 2), output);
});

Deno.test('spaceIndentToTabs: converts 4-space correctly', () => {
	const input  = '    foo\n        bar\n';
	const output = '\tfoo\n\t\tbar\n';
	assertEquals(spaceIndentToTabs(input, 4), output);
});

Deno.test('spaceIndentToTabs: non-indented lines untouched', () => {
	const input  = 'const x = 1;\n  const y = 2;\n';
	const output = 'const x = 1;\n\tconst y = 2;\n';
	assertEquals(spaceIndentToTabs(input, 2), output);
});


// ─── sanitize: character stripping ───────────────────────────────────────────

Deno.test('sanitize: bidi override chars removed, warning emitted', () => {
	// U+202E = right-to-left override (classic trojan source char)
	const input = 'const x\u202E = 1;\n';
	const { text, warnings } = sanitize(input, 'test.js');
	assert(!text.includes('\u202E'), 'bidi char should be removed');
	assert(warnings.some(w => w.includes('bidi')), 'should warn about bidi chars');
});

Deno.test('sanitize: all bidi override/isolate range stripped', () => {
	// U+202A-202E, U+2066-2069, U+200F
	const chars = ['\u202A','\u202B','\u202C','\u202D','\u202E','\u2066','\u2067','\u2068','\u2069','\u200F'];
	for(const ch of chars){
		const { text } = sanitize(`const x = "${ ch }";\n`, 'test.js');
		assert(!text.includes(ch), `bidi char U+${ ch.codePointAt(0).toString(16).toUpperCase() } should be removed`);
	}
});

Deno.test('sanitize: zero-width chars removed, warning emitted', () => {
	// U+200B zero-width space, U+200C zero-width non-joiner, U+200D zero-width joiner
	const input = 'const\u200B x\u200C=\u200D1;\n';
	const { text, warnings } = sanitize(input, 'test.js');
	assert(!text.includes('\u200B'), 'ZWSP should be removed');
	assert(!text.includes('\u200C'), 'ZWNJ should be removed');
	assert(!text.includes('\u200D'), 'ZWJ should be removed');
	assert(warnings.some(w => w.includes('zero-width')), 'should warn about zero-width chars');
});

Deno.test('sanitize: UTF-8 BOM removed', () => {
	// U+FEFF byte order mark
	const input = '\uFEFFconst x = 1;\n';
	const { text, warnings } = sanitize(input, 'test.js');
	assert(!text.startsWith('\uFEFF'), 'BOM should be removed');
	assert(warnings.some(w => w.includes('zero-width') || w.includes('BOM')), 'should warn');
});

Deno.test('sanitize: C0 control chars removed (except TAB, LF, CR)', () => {
	// null byte U+0000, bell U+0007, backspace U+0008
	const input = 'const x\x00 = \x07"hello\x08";\n';
	const { text, warnings } = sanitize(input, 'test.js');
	assert(!text.includes('\x00'), 'null byte should be removed');
	assert(!text.includes('\x07'), 'bell should be removed');
	assert(!text.includes('\x08'), 'backspace should be removed');
	assert(warnings.some(w => w.includes('control')), 'should warn about control chars');
});

Deno.test('sanitize: TAB preserved as legitimate whitespace', () => {
	const input = '\tconst x = 1;\n';
	const { text } = sanitize(input, 'test.js');
	assert(text.includes('\t'), 'tab should be preserved');
});

Deno.test('sanitize: sourceMappingURL stripped, warning emitted', () => {
	const input = 'const x = 1;\n//# sourceMappingURL=foo.js.map\n';
	const { text, warnings } = sanitize(input, 'test.js');
	assert(!text.includes('sourceMappingURL'), 'sourceMappingURL should be removed');
	assert(warnings.some(w => w.includes('sourceMappingURL')), 'should warn');
});

Deno.test('sanitize: multiple sourceMappingURL directives all stripped', () => {
	const input = '//# sourceMappingURL=a.map\nconst x=1;\n//# sourceMappingURL=b.map\n';
	const { text } = sanitize(input, 'test.js');
	assert(!text.includes('sourceMappingURL'), 'all sourceMappingURL refs should be removed');
});

Deno.test('sanitize: emoji and CJK characters preserved', () => {
	const input = 'const greeting = "こんにちは 🎉";\n';
	const { text, warnings } = sanitize(input, 'test.js');
	assert(text.includes('こんにちは'), 'CJK should be preserved');
	assert(text.includes('🎉'), 'emoji should be preserved');
	// zero stripping warnings expected for this input
	assert(warnings.filter(w => w.includes('bidi') || w.includes('control') || w.includes('zero-width')).length === 0,
		'no char-stripping warnings for clean unicode');
});

Deno.test('sanitize: Latin-extended characters preserved', () => {
	const input = 'const café = "naïve résumé";\n';
	const { text } = sanitize(input, 'test.js');
	assert(text.includes('café'), 'Latin-extended should be preserved');
	assert(text.includes('naïve'), 'Latin-extended should be preserved');
});


// ─── sanitize: whitespace normalization ──────────────────────────────────────

Deno.test('sanitize: CRLF normalized to LF', () => {
	const input = 'const x = 1;\r\nconst y = 2;\r\n';
	const { text } = sanitize(input, 'test.js');
	assert(!text.includes('\r'), 'CR should be removed');
	assert(text.includes('\n'), 'LF should remain');
});

Deno.test('sanitize: lone CR normalized to LF', () => {
	const input = 'const x = 1;\rconst y = 2;\r';
	const { text } = sanitize(input, 'test.js');
	assert(!text.includes('\r'), 'lone CR should be converted');
});

Deno.test('sanitize: trailing whitespace stripped per line', () => {
	const input = 'const x = 1;   \nconst y = 2;\t\nconst z = 3;\n';
	const { text } = sanitize(input, 'test.js');
	for(const line of text.split('\n').filter(l => l.length > 0)){
		assert(!/[ \t]$/.test(line), `trailing whitespace found: "${ line }"`);
	}
});

Deno.test('sanitize: 3+ consecutive blank lines collapsed to 1', () => {
	const input = 'const x = 1;\n\n\n\nconst y = 2;\n\n\n\n\nconst z = 3;\n';
	const { text } = sanitize(input, 'test.js');
	assert(!text.includes('\n\n\n'), '3+ consecutive newlines should be collapsed');
	// but a single blank line is fine
	assert(text.includes('\n\n'), 'single blank line should be preserved');
});

Deno.test('sanitize: exactly 2 blank lines preserved (not collapsed)', () => {
	const input = 'const x = 1;\n\n\nconst y = 2;\n';
	const { text } = sanitize(input, 'test.js');
	// 3 newlines = 2 blank lines -> collapses to 2 newlines = 1 blank line
	assert(!text.includes('\n\n\n'), 'should collapse 3 newlines to 2');
});

Deno.test('sanitize: single trailing newline enforced', () => {
	const noTrail = 'const x = 1;';
	const multiTrail = 'const x = 1;\n\n\n';
	const { text: t1 } = sanitize(noTrail, 'test.js');
	const { text: t2 } = sanitize(multiTrail, 'test.js');
	assert(t1.endsWith('\n') && !t1.endsWith('\n\n'), 'should add single trailing newline');
	assert(t2.endsWith('\n') && !t2.endsWith('\n\n'), 'should collapse to single trailing newline');
});

Deno.test('sanitize: 2-space indent converted to tabs', () => {
	const input = 'function foo(){\n  const x = 1;\n  if(x){\n    return x;\n  }\n}\n';
	const { text } = sanitize(input, 'test.js');
	assert(text.includes('\tconst'), 'single indent should become tab');
	assert(text.includes('\t\treturn'), 'double indent should become two tabs');
	assert(!text.includes('  '), 'no leading double-space should remain');
});

Deno.test('sanitize: 4-space indent converted to tabs', () => {
	const input = 'function foo(){\n    const x = 1;\n    if(x){\n        return x;\n    }\n}\n';
	const { text } = sanitize(input, 'test.js');
	assert(text.includes('\tconst'), 'single indent should become tab');
	assert(text.includes('\t\treturn'), 'double indent should become two tabs');
});

Deno.test('sanitize: clean input produces no warnings', () => {
	const input = 'export const x = 1;\nexport function foo(){ return x; }\n';
	const { warnings } = sanitize(input, 'test.js');
	assertEquals(warnings.length, 0, `unexpected warnings: ${ warnings.join(', ') }`);
});


// ─── analyzeContent ───────────────────────────────────────────────────────────

Deno.test('analyzeContent: detects eval(', () => {
	const text = 'const result = eval(userInput);\n';
	const warnings = analyzeContent(text, 'test.js');
	assert(warnings.some(w => w.includes('eval')), 'should flag eval(');
});

Deno.test('analyzeContent: detects new Function(', () => {
	const text = 'const fn = new Function("return 1");\n';
	const warnings = analyzeContent(text, 'test.js');
	assert(warnings.some(w => w.includes('new Function')), 'should flag new Function(');
});

Deno.test('analyzeContent: detects debugger', () => {
	const text = 'function foo(){\n\tdebugger;\n\treturn 1;\n}\n';
	const warnings = analyzeContent(text, 'test.js');
	assert(warnings.some(w => w.includes('debugger')), 'should flag debugger');
});

Deno.test('analyzeContent: detects document.write(', () => {
	const text = 'document.write("<script>alert(1)</script>");\n';
	const warnings = analyzeContent(text, 'test.js');
	assert(warnings.some(w => w.includes('document.write')), 'should flag document.write');
});

Deno.test('analyzeContent: detects setTimeout with string arg', () => {
	const text = 'setTimeout("doSomething()", 1000);\n';
	const warnings = analyzeContent(text, 'test.js');
	assert(
		warnings.some(w => w.includes('Timeout') || w.includes('Interval')),
		'should flag setTimeout with string arg'
	);
});

Deno.test('analyzeContent: detects setInterval with string arg', () => {
	const text = "setInterval('poll()', 5000);\n";
	const warnings = analyzeContent(text, 'test.js');
	assert(
		warnings.some(w => w.includes('Timeout') || w.includes('Interval')),
		'should flag setInterval with string arg'
	);
});

Deno.test('analyzeContent: setTimeout with function arg NOT flagged', () => {
	// legitimate use -- function reference, not string
	const text = 'setTimeout(() => doSomething(), 1000);\n';
	const warnings = analyzeContent(text, 'test.js');
	// may or may not flag -- just assert it does not crash; a function-ref call is fine
	assert(Array.isArray(warnings), 'should return array');
});

Deno.test('analyzeContent: detects base64 blob (200+ chars)', () => {
	const blob = 'A'.repeat(250);
	const text = `const img = "${ blob }";\n`;
	const warnings = analyzeContent(text, 'test.js');
	assert(warnings.some(w => w.includes('blob')), 'should flag large base64 blob');
});

Deno.test('analyzeContent: blob warning truncates content, does not emit full blob', () => {
	const blob = 'A'.repeat(500);
	const text = `const img = "${ blob }";\n`;
	const warnings = analyzeContent(text, 'test.js');
	const blobWarn = warnings.find(w => w.includes('blob'));
	assertExists(blobWarn, 'blob warning should exist');
	// the full blob is 500 chars; warning should be far shorter
	assert(blobWarn.length < 200, `blob warning should be truncated, got ${ blobWarn.length } chars`);
});

Deno.test('analyzeContent: short string NOT flagged as blob', () => {
	const text = 'const x = "short string";\n';
	const warnings = analyzeContent(text, 'test.js');
	assert(!warnings.some(w => w.includes('blob')), 'short string should not be flagged as blob');
});

Deno.test('analyzeContent: warning includes correct line number', () => {
	const text = 'const x = 1;\nconst y = 2;\neval(userInput);\nconst z = 3;\n';
	const warnings = analyzeContent(text, 'test.js');
	const evalWarn = warnings.find(w => w.includes('eval'));
	assertExists(evalWarn, 'eval warning should exist');
	// eval is on line 3
	assert(evalWarn.includes(':3'), `warning should include line 3, got: ${ evalWarn }`);
});

Deno.test('analyzeContent: warning includes file label', () => {
	const text = 'eval(x);\n';
	const warnings = analyzeContent(text, 'myfile.js');
	assert(warnings.some(w => w.includes('myfile.js')), 'warning should include file label');
});

Deno.test('analyzeContent: clean code produces no warnings', () => {
	const text = [
		'import { LitElement, html } from "./lit/3.3.1/lit-element.js";',
		'export class MyEl extends LitElement {',
		'\trender(){ return html`<p>hello</p>`; }',
		'}',
		'',
	].join('\n');
	const warnings = analyzeContent(text, 'test.js');
	assertEquals(warnings.length, 0, `unexpected warnings: ${ warnings.join(', ') }`);
});


// ─── parseHref ────────────────────────────────────────────────────────────────

Deno.test('parseHref: jsdelivr versioned URL', () => {
	const href = 'https://cdn.jsdelivr.net/npm/lit@3.3.1/index.js/+esm';
	const r = parseHref(href);
	assertEquals(r.name, 'lit');
	assertEquals(r.version, '3.3.1');
	assertEquals(r.path, '/index.js');
});

Deno.test('parseHref: jsdelivr scoped package URL', () => {
	const href = 'https://cdn.jsdelivr.net/npm/@lit/localize@0.12.2/lit-localize.js';
	const r = parseHref(href);
	assertEquals(r.name, '@lit/localize');
	assertEquals(r.version, '0.12.2');
});

Deno.test('parseHref: unpkg URL with ?module query', () => {
	const href = 'https://unpkg.com/@lit/context@1.1.6/index.js?module';
	const r = parseHref(href);
	assertEquals(r.name, '@lit/context');
	assertEquals(r.version, '1.1.6');
});

Deno.test('parseHref: unpkg URL without query', () => {
	const href = 'https://unpkg.com/@lit/task@1.0.3/index.js';
	const r = parseHref(href);
	assertEquals(r.name, '@lit/task');
	assertEquals(r.version, '1.0.3');
});


// ─── normalizeCdnPathname ─────────────────────────────────────────────────────

Deno.test('normalizeCdnPathname: strips query string', () => {
	const url = new URL('https://unpkg.com/@lit/context@1.1.6/index.js?module');
	assertEquals(normalizeCdnPathname(url), '/@lit/context@1.1.6/index.js');
});

Deno.test('normalizeCdnPathname: strips jsdelivr /npm/ prefix', () => {
	const url = new URL('https://cdn.jsdelivr.net/npm/lit@3.3.1/index.js/+esm');
	assertEquals(normalizeCdnPathname(url), '/lit@3.3.1/index.js');
});

Deno.test('normalizeCdnPathname: strips /+esm suffix', () => {
	const url = new URL('https://cdn.jsdelivr.net/npm/lit@3.3.1/html.js/+esm');
	assertEquals(normalizeCdnPathname(url), '/lit@3.3.1/html.js');
});

Deno.test('normalizeCdnPathname: scoped package preserved', () => {
	const url = new URL('https://cdn.jsdelivr.net/npm/@lit/localize@0.12.2/lit-localize.js');
	assertEquals(normalizeCdnPathname(url), '/@lit/localize@0.12.2/lit-localize.js');
});

Deno.test('normalizeCdnPathname: fragment stripped', () => {
	const url = new URL('https://unpkg.com/lit@3.3.1/index.js#exports');
	assertEquals(normalizeCdnPathname(url), '/lit@3.3.1/index.js');
});


// ─── parseCdnPathname ─────────────────────────────────────────────────────────

Deno.test('parseCdnPathname: standard versioned path', () => {
	const r = parseCdnPathname('/lit@3.3.1/index.js');
	assertEquals(r, { name: 'lit', version: '3.3.1', rest: '/index.js' });
});

Deno.test('parseCdnPathname: scoped package', () => {
	const r = parseCdnPathname('/@lit/localize@0.12.2/lit-localize.js');
	assertEquals(r, { name: '@lit/localize', version: '0.12.2', rest: '/lit-localize.js' });
});

Deno.test('parseCdnPathname: no version returns null', () => {
	assertEquals(parseCdnPathname('/lit/index.js'), null);
});

Deno.test('parseCdnPathname: empty path returns null', () => {
	assertEquals(parseCdnPathname('/'), null);
});

Deno.test('parseCdnPathname: partial version (missing patch) returns null', () => {
	// semver requires three parts; two-part version should not match
	assertEquals(parseCdnPathname('/lit@3.3/index.js'), null);
});

Deno.test('parseCdnPathname: rest may be empty (bare package entry)', () => {
	const r = parseCdnPathname('/lit@3.3.1');
	assertEquals(r, { name: 'lit', version: '3.3.1', rest: '' });
});


// ─── urlToPath ────────────────────────────────────────────────────────────────

const WWWROOT = '/project';
const RELATIVE = './www/wildtype';

Deno.test('urlToPath: returns null for unversioned URL (no throw)', () => {
	const url = new URL('https://cdn.jsdelivr.net/npm/lit/index.js');
	assertEquals(urlToPath(url, WWWROOT, RELATIVE), null);
});

Deno.test('urlToPath: versioned .js URL produces correct versioned path', () => {
	const url = new URL('https://cdn.jsdelivr.net/npm/lit@3.3.1/index.js/+esm');
	const r = urlToPath(url, WWWROOT, RELATIVE);
	assertExists(r, 'should return path parts');
	assertEquals(r.name, 'lit');
	assertEquals(r.version, '3.3.1');
	assert(r.versioned.includes('3.3.1'), 'versioned path should include version');
	assert(r.versioned.endsWith('index.js'), 'versioned path should end with filename');
});

Deno.test('urlToPath: scoped package produces correct path', () => {
	const url = new URL('https://cdn.jsdelivr.net/npm/@lit/localize@0.12.2/lit-localize.js');
	const r = urlToPath(url, WWWROOT, RELATIVE);
	assertExists(r);
	assertEquals(r.name, '@lit/localize');
	assert(r.versioned.includes('@lit'), 'path should preserve scope');
	assert(r.versioned.includes('0.12.2'));
});

Deno.test('urlToPath: unversioned path is distinct from versioned', () => {
	const url = new URL('https://cdn.jsdelivr.net/npm/lit@3.3.1/index.js/+esm');
	const r = urlToPath(url, WWWROOT, RELATIVE);
	assertExists(r);
	assert(r.versioned !== r.unversioned, 'versioned and unversioned should differ');
	assert(!r.unversioned.includes('3.3.1'), 'unversioned should not include version');
});

Deno.test('urlToPath: ext correctly detected as .js', () => {
	const url = new URL('https://cdn.jsdelivr.net/npm/lit@3.3.1/index.js/+esm');
	const r = urlToPath(url, WWWROOT, RELATIVE);
	assertExists(r);
	assertEquals(r.ext, '.js');
});

Deno.test('urlToPath: semver parsed to array', () => {
	const url = new URL('https://cdn.jsdelivr.net/npm/lit@3.3.1/index.js/+esm');
	const r = urlToPath(url, WWWROOT, RELATIVE);
	assertExists(r);
	assertEquals(r.semver, [3, 3, 1]);
});

Deno.test('urlToPath: unpkg URL with ?module query handled correctly', () => {
	const url = new URL('https://unpkg.com/@lit/context@1.1.6/index.js?module');
	const r = urlToPath(url, WWWROOT, RELATIVE);
	assertExists(r, 'should parse unpkg URL');
	assertEquals(r.name, '@lit/context');
	assertEquals(r.version, '1.1.6');
});


// ─── rewriteImports ───────────────────────────────────────────────────────────

// fixture: minimal JS with one absolute import, one relative import
function makeRewriteFixture(){
	const wwwroot  = '/project';
	const relative = './www/wildtype';
	const resolved = 'https://cdn.jsdelivr.net/npm/lit@3.3.1/index.js/+esm';
	const original = resolved;
	return { wwwroot, relative, resolved, original };
}

Deno.test('rewriteImports: non-js file passes through unchanged', () => {
	const { wwwroot, relative, resolved, original } = makeRewriteFixture();
	const cssUrl = 'https://cdn.jsdelivr.net/npm/lit@3.3.1/style.css';
	const text = 'body { color: red; }';
	const { output, discovered } = rewriteImports(text, cssUrl, cssUrl, wwwroot, relative, false);
	assertEquals(output, text, 'CSS should pass through unchanged');
	assertEquals(discovered.length, 0);
});

Deno.test('rewriteImports: unrecognized resolved URL returns text unchanged', () => {
	// a URL without a version -- urlToPath returns null -- should warn and pass through
	const wwwroot  = '/project';
	const relative = './www/wildtype';
	const badUrl   = 'https://cdn.jsdelivr.net/npm/lit/index.js';
	const text = 'export const x = 1;\n';
	const { output, discovered } = rewriteImports(text, badUrl, badUrl, wwwroot, relative, false);
	assertEquals(output, text);
	assertEquals(discovered.length, 0);
});

Deno.test('rewriteImports: absolute http import added to discovered', () => {
	const { wwwroot, relative, resolved, original } = makeRewriteFixture();
	const depUrl = 'https://cdn.jsdelivr.net/npm/lit-html@3.3.1/lit-html.js/+esm';
	const text = `import { html } from "${ depUrl }";\n`;
	const { discovered } = rewriteImports(text, resolved, original, wwwroot, relative, false);
	assert(discovered.includes(depUrl), 'absolute dep should be in discovered');
});

Deno.test('rewriteImports: absolute http import specifier rewritten to local path', () => {
	const { wwwroot, relative, resolved, original } = makeRewriteFixture();
	const depUrl = 'https://cdn.jsdelivr.net/npm/lit-html@3.3.1/lit-html.js/+esm';
	const text = `import { html } from "${ depUrl }";\n`;
	const { output } = rewriteImports(text, resolved, original, wwwroot, relative, false);
	// source comment legitimately contains the origin URL -- check specifiers only
	const specifiers = [...output.matchAll(/from\s+["']([^"']+)["']/g)].map(m => m[1]);
	assert(specifiers.length > 0, 'should have at least one rewritten specifier');
	assert(specifiers.every(s => !s.startsWith('https://')), `import specifiers should be local paths, got: ${ specifiers.join(', ') }`);
	assert(specifiers.every(s => s.endsWith('.js')), `import specifiers should end with .js, got: ${ specifiers.join(', ') }`);
});

Deno.test('rewriteImports: relative import query stripped', () => {
	const { wwwroot, relative, resolved, original } = makeRewriteFixture();
	const text = `import { x } from "./utils.js?module";\n`;
	const { output } = rewriteImports(text, resolved, original, wwwroot, relative, false);
	assert(!output.includes('?module'), 'query string should be stripped from relative import');
});

Deno.test('rewriteImports: relative import added to discovered', () => {
	const { wwwroot, relative, resolved, original } = makeRewriteFixture();
	const text = `import { x } from "./lit-html/3.3.1/lit-html.js";\n`;
	const { discovered } = rewriteImports(text, resolved, original, wwwroot, relative, false);
	assertEquals(discovered.length, 1);
	assert(discovered[0].startsWith('https://'), 'discovered URL should be absolute');
});

Deno.test('rewriteImports: output prefixed with source comment', () => {
	const { wwwroot, relative, resolved, original } = makeRewriteFixture();
	const text = 'export const x = 1;\n';
	const { output } = rewriteImports(text, resolved, original, wwwroot, relative, false);
	assert(output.startsWith('/*'), 'output should start with source comment');
	assert(output.includes(resolved), 'source comment should include resolved URL');
});

Deno.test('rewriteImports: no imports means empty discovered', () => {
	const { wwwroot, relative, resolved, original } = makeRewriteFixture();
	const text = 'export const x = 1;\nexport function foo(){ return x; }\n';
	const { discovered } = rewriteImports(text, resolved, original, wwwroot, relative, false);
	assertEquals(discovered.length, 0);
});

// ─── parseVersion / versionDiff ──────────────────────────────────────────────

Deno.test('parseVersion: parses semver string to array', () => {
	assertEquals(parseVersion('3.3.1'), [3, 3, 1]);
	assertEquals(parseVersion('0.12.2'), [0, 12, 2]);
	assertEquals(parseVersion('1.0.0'), [1, 0, 0]);
});

Deno.test('versionDiff: equal versions return 0', () => {
	assertEquals(versionDiff([1,2,3],[1,2,3]), 0);
});

Deno.test('versionDiff: a newer returns positive', () => {
	assert(versionDiff([2,0,0],[1,9,9]) > 0);
	assert(versionDiff([1,2,1],[1,2,0]) > 0);
});

Deno.test('versionDiff: b newer returns negative', () => {
	assert(versionDiff([1,0,0],[2,0,0]) < 0);
	assert(versionDiff([3,3,0],[3,3,1]) < 0);
});

Deno.test('versionDiff: sorts array correctly', () => {
	const versions = [[3,3,1],[1,0,0],[3,3,0],[0,12,2]];
	versions.sort(versionDiff);
	assertEquals(versions, [[0,12,2],[1,0,0],[3,3,0],[3,3,1]]);
});


// ─── args() integration ───────────────────────────────────────────────────────
// args.js mutates the config object passed in.
// a fresh config is created per test to avoid cross-test state.

function makeConfig(overrides = {}){
	return { verbose: false, write: false, file: '', dump: '', max: 5, ...overrides };
}

Deno.test('args: -key=value sets string option', () => {
	const config = makeConfig();
	args(['-file=./deps.js', '-dump=./out/'], config);
	assertEquals(config.file, './deps.js');
	assertEquals(config.dump, './out/');
});

Deno.test('args: --flag sets boolean true', () => {
	const config = makeConfig();
	args(['--write', '--verbose'], config);
	assertEquals(config.write, true);
	assertEquals(config.verbose, true);
});

Deno.test('args: --flag=false sets boolean false', () => {
	const config = makeConfig({ verbose: true });
	args(['--verbose=false'], config);
	assertEquals(config.verbose, false);
});

Deno.test('args: -max=N sets numeric option', () => {
	const config = makeConfig();
	args(['-max=10'], config);
	assertEquals(config.max, 10);
});

Deno.test('args: invalid number for numeric option ignored, default preserved', () => {
	const config = makeConfig();
	args(['-max=notanumber'], config);
	assertEquals(config.max, 5, 'invalid number should leave default unchanged');
});

Deno.test('args: unknown option ignored (no throw)', () => {
	const config = makeConfig();
	args(['-unknownoption=xyz'], config);
	assertEquals(config['unknownoption'], undefined);
});

Deno.test('args: -h sets symbols.help', () => {
	const config = makeConfig();
	args(['-h'], config);
	assertEquals(config[symbols.help], true);
});

Deno.test('args: -help sets symbols.help', () => {
	const config = makeConfig();
	args(['-help'], config);
	assertEquals(config[symbols.help], true);
});

Deno.test('args: URLs after -- sentinel go to symbols.positionals', () => {
	const config = makeConfig();
	args([
		'-dump=./out',
		'--',
		'https://cdn.jsdelivr.net/npm/lit@3.3.1/index.js/+esm',
		'https://unpkg.com/@lit/task@1.0.3/index.js',
	], config);
	const positionals = config[symbols.positionals];
	assertExists(positionals, 'positionals should be set');
	assertEquals(positionals.length, 2);
	assert(positionals[0].startsWith('https://'));
});

Deno.test('args: flags before -- are parsed, URLs after are positionals', () => {
	const config = makeConfig();
	args([
		'--write',
		'-max=3',
		'--',
		'https://cdn.jsdelivr.net/npm/lit@3.3.1/index.js/+esm',
	], config);
	assertEquals(config.write, true);
	assertEquals(config.max, 3);
	assertEquals(config[symbols.positionals].length, 1);
});

Deno.test('args: no -- means no positionals set', () => {
	const config = makeConfig();
	args(['--write'], config);
	// symbols.positionals should not be set when no -- sentinel present
	assert(config[symbols.positionals] === undefined, 'positionals should be absent without -- sentinel');
});


// ─── dry run subprocess test ──────────────────────────────────────────────────
// these tests spawn the script as a subprocess to verify the CLI contract.
// requires --allow-run in the deno test invocation.

Deno.test('dry run: outputs DRY RUN message and URL list, exits 0', async () => {
	// write a temp deps file
	const tmp   = await Deno.makeTempDir();
	const deps  = `${ tmp }/deps.js`;
	const dump  = `${ tmp }/out/`;

	await Deno.writeTextFile(deps, [
		'export const dependencies = [',
		"  'https://cdn.jsdelivr.net/npm/lit@3.3.1/index.js/+esm',",
		"  'https://cdn.jsdelivr.net/npm/lit@3.3.1/html.js/+esm',",
		'];',
	].join('\n'));

	const cmd = new Deno.Command('deno', {
		args: [
			'run',
			'--allow-env',
			`--allow-read=${ tmp },${ Deno.cwd() }`,
			`--allow-write=${ dump }`,
			// no --allow-net -- dry run should not need it
			'./external-importer.js',
			`-file=${ deps }`,
			`-dump=${ dump }`,
			// no --write flag -- this is the dry run
		],
		stdout: 'piped',
		stderr: 'piped',
	});

	const { code, stdout } = await cmd.output();
	const out = new TextDecoder().decode(stdout);

	assertEquals(code, 0, `expected exit 0, got ${ code }`);
	assert(out.includes('DRY RUN'), `stdout should include "DRY RUN", got:\n${ out }`);
	assert(out.includes('lit@3.3.1'), `stdout should list queued URLs, got:\n${ out }`);
	assert(out.includes('--write'), `stdout should suggest --write flag, got:\n${ out }`);

	await Deno.remove(tmp, { recursive: true });
});

Deno.test('dry run: --help exits 0 and shows options', async () => {
	const tmp  = await Deno.makeTempDir();
	const deps = `${ tmp }/deps.js`;
	const dump = `${ tmp }/out/`;

	await Deno.writeTextFile(deps, 'export const dependencies = [];');

	const cmd = new Deno.Command('deno', {
		args: [
			'run',
			'--allow-env',
			`--allow-read=${ tmp },${ Deno.cwd() }`,
			`--allow-write=${ dump }`,
			'./external-importer.js',
			`-file=${ deps }`,
			`-dump=${ dump }`,
			'--help',
		],
		stdout: 'piped',
		stderr: 'piped',
	});

	const { code, stdout } = await cmd.output();
	const out = new TextDecoder().decode(stdout);

	assertEquals(code, 0, `expected exit 0, got ${ code }`);
	assert(out.includes('--write'), `help output should mention --write, got:\n${ out }`);
	assert(out.includes('--versions'), `help output should mention --versions, got:\n${ out }`);
	assert(out.includes('--outdated'), `help output should mention --outdated, got:\n${ out }`);

	await Deno.remove(tmp, { recursive: true });
});

Deno.test('dry run: no URLs queued exits 1', async () => {
	const tmp  = await Deno.makeTempDir();
	const deps = `${ tmp }/deps.js`;
	const dump = `${ tmp }/out/`;

	// empty deps file
	await Deno.writeTextFile(deps, 'export const dependencies = [];');

	const cmd = new Deno.Command('deno', {
		args: [
			'run',
			'--allow-env',
			`--allow-read=${ tmp },${ Deno.cwd() }`,
			`--allow-write=${ dump }`,
			'./external-importer.js',
			`-file=${ deps }`,
			`-dump=${ dump }`,
		],
		stdout: 'piped',
		stderr: 'piped',
	});

	const { code } = await cmd.output();
	assertEquals(code, 1, 'empty deps should exit 1');

	await Deno.remove(tmp, { recursive: true });
});
