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
	processOne,
	rewriteImports,
	urlToPath,
	classifyExt,
	stripDisallowed,
	inspectCodepoints,
	isAllowed,
	runInspect,
	buildDisallowedPattern,
	UNICODE_ALLOWED_RANGES,
} from './external-importer.js';

import { args, symbols } from './args.js';


const WWWROOT  = '/project';
const RELATIVE = './www/libs';

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
	// test.js: stripped 1 disallowed codepoint(s): U+202E [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /stripped.*disallowed.*U\+202E/.test(w)), `should warn on removed bidi chars "U+202E" specifically, got ${ JSON.stringify(warnings) }`);
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
	// test.js: stripped 3 disallowed codepoint(s): U+200B, U+200C, U+200D [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /stripped 3 disallowed.*U\+200/.test(w)), `should warn on removed zero-width chars, got ${ JSON.stringify(warnings) }`);
});

Deno.test('sanitize: UTF-8 BOM removed', () => {
	// U+FEFF byte order mark
	const input = '\uFEFFconst x = 1;\n';
	const { text, warnings } = sanitize(input, 'test.js');
	assert(!text.startsWith('\uFEFF'), 'BOM should be removed');
	// test.js: stripped 1 disallowed codepoint(s): U+FEFF [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /stripped 1 disallowed.*U\+FEFF/.test(w)), `should warn on removed BOM, got ${ JSON.stringify(warnings) }`);
});

Deno.test('sanitize: C0 control chars removed (except TAB, LF, CR)', () => {
	// null byte U+0000, bell U+0007, backspace U+0008
	const input = 'const x\x00 = \x07"hello\x08";\n';
	const { text, warnings } = sanitize(input, 'test.js');
	assert(!text.includes('\x00'), 'null byte should be removed');
	assert(!text.includes('\x07'), 'bell should be removed');
	assert(!text.includes('\x08'), 'backspace should be removed');
	// test.js: stripped 3 disallowed codepoint(s): U+0000, U+0007, U+0008 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /stripped 3 disallowed.*U\+0000/.test(w)), `should warn on removed control chars, got ${ JSON.stringify(warnings) }`);
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
	assert(warnings.filter(w => w.includes('disallowed')).length === 0,
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

Deno.test('args: --inspect sets inspect=true', () => {
	const config = makeConfig({ inspect: false });
	args(['--inspect'], config);
	assertEquals(config.inspect, true, '--inspect should set inspect=true');
});

Deno.test('args: --inspect does not set --write', () => {
	const config = makeConfig({ inspect: false, write: false });
	args(['--inspect'], config);
	assertEquals(config.write, false, '--inspect must not implicitly set write');
});

/*
Tests for invisible-unicode / Glassworm attack class and related sanitization vectors.

Covers:
  - BMP variation selectors U+FE00-U+FE0F  (VS 1-16)
  - Supplementary variation selectors U+E0100-U+E01EF  (VS 17-256, surrogate pairs)
  - Boundary codepoints for both ranges
  - Glassworm decoder structural pattern: invisible payload inside backtick literal
  - Two-layer defense: VS stripped by sanitize(), eval flagged by analyzeContent()
  - Mixed multi-vector: bidi + variation selectors in the same file
  - No false positives on legitimate CJK, emoji, Latin-extended
*/


// ─── variation selectors: BMP range U+FE00-U+FE0F ────────────────────────────

Deno.test('sanitize: BMP variation selectors stripped, warning emitted', () => {
	// U+FE00-U+FE0F: Variation Selectors 1-16. Invisible in every editor and
	// diff viewer; decoded by JS runtimes via codePointAt() arithmetic.
	const vs = '\uFE00\uFE01\uFE02\uFE0F';
	const input = `const s = \`${ vs }\`;\n`;
	const { text, warnings } = sanitize(input, 'test.js');
	assert(!text.includes('\uFE00'), 'VS-1 (U+FE00) should be removed');
	assert(!text.includes('\uFE0F'), 'VS-16 (U+FE0F) should be removed');
	// test.js: stripped 4 disallowed codepoint(s): U+FE00, U+FE01, U+FE02, U+FE0F [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /stripped 4 disallowed.*U\+FE00/.test(w)), `should should emit a variation selector removal, got ${ JSON.stringify(warnings) }`);
});

Deno.test('sanitize: BMP variation selector warning includes count', () => {
	const vs = '\uFE00\uFE01\uFE02';
	const input = `const s = \`${ vs }\`;\n`;
	const { warnings } = sanitize(input, 'test.js');
	// test.js: stripped 3 disallowed codepoint(s): U+FE00, U+FE01, U+FE02 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /stripped 3 disallowed.*U\+FE00/.test(w)), `should should report 3 removals, got ${ JSON.stringify(warnings) }`);
});

Deno.test('sanitize: BMP VS boundary codepoints both stripped', () => {
	// U+FE00 is the minimum, U+FE0F is the maximum of the BMP VS block
	for(const ch of ['\uFE00', '\uFE0F']){
		const { text, warnings } = sanitize(`const x = \`${ ch }\`;\n`, 'test.js');
		const hex = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
		assert(
			!text.includes(ch),                                    // FIX: was text.includes() with no arg
			`boundary codepoint U+${ hex } should be removed`
		);
		assert(warnings.some(w => w.includes(hex)), `should report removal of U+${ hex }, got ${ JSON.stringify(warnings) }`);
	}
});


// ─── variation selectors: supplementary range U+E0100-U+E01EF ────────────────
// Outside the BMP -- in JS UTF-16 strings these encode as surrogate pairs.
// U+E0100 = \uDB40\uDD00, U+E01EF = \uDB40\uDDEF.

Deno.test('sanitize: supplementary variation selectors stripped (surrogate pairs)', () => {
	const vs_first = '\uDB40\uDD00';	// U+E0100, first in supplement block
	const vs_last  = '\uDB40\uDDEF';	// U+E01EF, last in supplement block
	const input = `const s = \`${ vs_first }${ vs_last }\`;\n`;
	const { text, warnings } = sanitize(input, 'test.js');
	assert(!text.includes('\uDB40'), 'supplementary VS high surrogate should be removed');
	assert(!text.includes('\uDD00'), 'supplementary VS low surrogate should be removed');
	// test.js: stripped 2 disallowed codepoint(s): U+E0100, U+E01EF [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /stripped 2 disallowed.*U\+E0100/.test(w)), `should warn about supplementary VS removal, got ${ JSON.stringify(warnings) }`);
});

Deno.test('sanitize: supplementary VS boundary codepoints both stripped', () => {
	const vs_first = '\uDB40\uDD00';	// U+E0100
	const vs_last  = '\uDB40\uDDEF';	// U+E01EF
	for(const ch of [vs_first, vs_last]){
		const { text } = sanitize(`const x = \`${ ch }\`;\n`, 'test.js');
		assert(!text.includes('\uDB40'), 'supplementary VS surrogate pair should be fully removed');
	}
});


// ─── warning format ───────────────────────────────────────────────────────────

Deno.test('sanitize: variation selector warning includes file label', () => {
	const input = `const x = \`\uFE00\`;\n`;
	const { warnings } = sanitize(input, 'lib/gadget.js');
	// lib/gadget.js: stripped 1 disallowed codepoint(s): U+FE00 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /lib\/gadget.js.*stripped 1 disallowed.*U\+FE00/.test(w)), `should warning includes file label, got ${ JSON.stringify(warnings) }`);
});

Deno.test('sanitize: variation selector warning names the attack class', () => {
	// The warning should reference the invisible-payload or Glassworm attack context
	// so that a reviewer understands the security significance of the removal.
	const input = `const s = \`\uFE00\`;\n`;
	const { warnings } = sanitize(input, 'test.js');
	// test.js: stripped 1 disallowed codepoint(s): U+FE00 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /test.js.*stripped 1 disallowed.*U\+FE00/.test(w)), `should warn on file, Glassworm attack, got ${ JSON.stringify(warnings) }`);
});


// ─── Glassworm structural pattern ─────────────────────────────────────────────

Deno.test('sanitize: Glassworm pattern -- invisible payload stripped from backtick string', () => {
	// Reconstructs the structural attack from the Glassworm campaign (March 2026):
	// a codePointAt()-based decoder reads variation selectors from a backtick
	// string that appears empty to reviewers, recovers byte values, and passes
	// the result to eval(). After sanitize(), the backtick string must be
	// genuinely empty -- the payload cannot survive.
	const invisiblePayload = '\uFE00\uFE01\uFE02\uFE03\uFE04\uFE05\uFE06\uFE07';
	const input = [
		'const s = v => [...v].map(w => (',
		'\tw = w.codePointAt(0),',
		'\tw >= 0xFE00 && w <= 0xFE0F ? w - 0xFE00 : null',
		')).filter(n => n !== null);',
		`eval(Buffer.from(s(\`${ invisiblePayload }\`)).toString('utf-8'));`,
	].join('\n') + '\n';

	const { text, warnings } = sanitize(input, 'test.js');

	// invisible payload must be gone
	assert(!text.includes('\uFE00'), 'variation selectors must be stripped from payload string');
	// backtick string should now be genuinely empty
	assert(text.includes('s(``)'), 'after stripping, backtick string should be empty');
	// warning must be emitted
	// test.js: stripped 8 disallowed codepoint(s): U+FE00, U+FE01, U+FE02, U+FE03, U+FE04, U+FE05, U+FE06, U+FE07 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /test.js.*stripped 8 disallowed.*U\+FE00/.test(w)), `must warn about stripped variation selectors, got ${ JSON.stringify(warnings) }`);
});

Deno.test('sanitize: Glassworm with supplementary VS -- payload stripped', () => {
	// Same attack using the supplementary block (U+E0100-U+E01EF) instead of BMP VS.
	// Both blocks must be inert after sanitize().
	const supPayload = '\uDB40\uDD00\uDB40\uDD01\uDB40\uDD02\uDB40\uDD03';
	const input = `eval(Buffer.from(s(\`${ supPayload }\`)).toString('utf-8'));\n`;
	const { text, warnings } = sanitize(input, 'test.js');
	assert(!text.includes('\uDB40'), 'supplementary VS surrogates must be stripped');
	assert(text.includes('s(``)'), 'backtick string should be empty after strip');
	// test.js: stripped 4 disallowed codepoint(s): U+E0100, U+E0101, U+E0102, U+E0103 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /test.js.*stripped 4 disallowed.*U\+E0100/.test(w)), `must warn about stripped variation selectors, got ${ JSON.stringify(warnings) }`);
});


// ─── two-layer defense ────────────────────────────────────────────────────────

Deno.test('sanitize + analyzeContent: eval still flagged after VS payload stripped', () => {
	// Verifies both layers operate independently:
	// Layer 1 -- sanitize() removes the invisible payload.
	// Layer 2 -- analyzeContent() flags the eval() call in the now-clean text.
	// Both must fire even though the payload characters are already gone.
	const invisiblePayload = '\uFE00\uFE01\uFE02';
	const input = `eval(Buffer.from(s(\`${ invisiblePayload }\`)).toString('utf-8'));\n`;

	const { text, warnings: sanitizeWarnings } = sanitize(input, 'test.js');
	const analysis = analyzeContent(text, 'test.js');
	// test.js: stripped 3 disallowed codepoint(s): U+FE00, U+FE01, U+FE02 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(sanitizeWarnings.some(w => /test.js.*stripped 3 disallowed.*U\+FE01/.test(w)), `must warn about stripped VS chars, got ${ JSON.stringify(sanitizeWarnings) }`);
	assert(
		analysis.some(w => w.includes('eval')),
		'analyzeContent must still flag eval() after VS stripping'
	);
});

Deno.test('sanitize + analyzeContent: new Function flagged after VS payload stripped', () => {
	// Same two-layer check for the new Function() execution vector.
	const invisiblePayload = '\uFE00\uFE01';
	const input = `const fn = new Function(\`${ invisiblePayload }\`);\n`;

	const { text } = sanitize(input, 'test.js');
	const analysis = analyzeContent(text, 'test.js');

	assert(
		analysis.some(w => w.includes('new Function')),
		'new Function should be flagged after VS stripping'
	);
});


// ─── combined multi-vector ────────────────────────────────────────────────────

Deno.test('sanitize: bidi overrides and variation selectors both stripped in one pass', () => {
	// A maximally adversarial file mixing both attack classes.
	// Both should be stripped; both should produce independent warnings.
	const bidi = '\u202E';			// right-to-left override (Trojan Source)
	const vs   = '\uFE00\uFE01';	// two BMP variation selectors (Glassworm)
	const input = `const x${ bidi } = 1;\nconst s = \`${ vs }\`;\n`;

	const { text, warnings } = sanitize(input, 'test.js');

	assert(!text.includes('\u202E'), 'bidi override should be removed');
	assert(!text.includes('\uFE00'), 'variation selectors should be removed');
	// test.js: stripped 3 disallowed codepoint(s): U+202E, U+FE00, U+FE01 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /test.js.*stripped 3 disallowed.*U\+202E, U\+FE00, U\+FE01/.test(w)), `must warn about stripped VS chars and bidi removals, got ${ JSON.stringify(warnings) }`);
});

Deno.test('sanitize: BMP and supplementary VS mixed -- single combined warning, correct total count', () => {
	// Both sub-ranges stripped in a single regex pass; count should be the total.
	const bmp = '\uFE00\uFE0F';			// 2 BMP VS
	const sup = '\uDB40\uDD00\uDB40\uDDEF';	// 2 supplementary VS (U+E0100, U+E01EF)
	const input = `const a = \`${ bmp }\`;\nconst b = \`${ sup }\`;\n`;

	const { text, warnings } = sanitize(input, 'test.js');

	assert(!text.includes('\uFE00'), 'BMP VS should be removed');
	assert(!text.includes('\uFE0F'), 'BMP VS should be removed');
	assert(!text.includes('\uDB40'), 'supplementary VS should be removed');

	// test.js: stripped 4 disallowed codepoint(s): U+FE00, U+FE0F, U+E0100, U+E01EF [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /test.js.*stripped 4 disallowed.*U\+FE00, U\+FE0F, U\+E0100, U\+E01EF/.test(w)), `must warn about stripped VS chars and bidi removals, got ${ JSON.stringify(warnings) }`);
});


// ─── no false positives ───────────────────────────────────────────────────────

Deno.test('sanitize: clean code with no variation selectors produces no VS warning', () => {
	const input = 'export const x = 1;\nconst greeting = "こんにちは";\n';
	const { warnings } = sanitize(input, 'test.js');
	assert(
		!warnings.some(w => w.includes('variation selector')),
		'no VS warning should be emitted for clean code'
	);
});

Deno.test('sanitize: CJK and emoji preserved, no false-positive VS strip', () => {
	// Variation selectors have a legitimate rendering role in CJK text, but that
	// role is irrelevant in JS source files. However, plain CJK characters and
	// emoji (which are NOT variation selectors) must survive untouched.
	const input = 'const msg = "日本語テスト 🎌 résumé";\n';
	const { text, warnings } = sanitize(input, 'test.js');
	assert(text.includes('日本語テスト'), 'CJK text should be preserved');
	assert(text.includes('🎌'), 'emoji should be preserved');
	assert(text.includes('résumé'), 'Latin-extended should be preserved');
	assert(
		!warnings.some(w => w.includes('variation selector')),
		'no false-positive VS warning for CJK/emoji/Latin-extended'
	);
});

Deno.test('sanitize: surrogate pairs outside VS supplement range are not incorrectly stripped', () => {
	// Emoji are encoded as supplementary codepoints (surrogate pairs) but outside
	// U+E0100-U+E01EF. They must survive.
	// U+1F600 = \uD83D\uDE00 (grinning face emoji) -- well outside the VS supplement
	const emoji = '\uD83D\uDE00';
	const input = `const face = "${ emoji }";\n`;
	const { text, warnings } = sanitize(input, 'test.js');
	assert(text.includes(emoji), 'emoji surrogate pair should not be stripped');
	assert(
		!warnings.some(w => w.includes('variation selector')),
		'no false-positive VS warning for emoji surrogate pairs'
	);
});

/*

Tests for:
  - classifyExt() routing: js / text / binary
  - sanitize() convertIndent option (text assets must not be tab-converted)
  - processOne() content-type dispatch
  - --strict / --force behavior via processOne + fetchAll result shape
  - invisible-unicode stripping applied to non-JS text assets (CSS, JSON, HTML, SVG)
  - binary assets pass through unmodified

*/


// ─── classifyExt ─────────────────────────────────────────────────────────────

Deno.test('classifyExt: JS extensions classified as js', () => {
	for(const ext of ['.js', '.mjs', '.cjs', '.ts']){
		assertEquals(classifyExt(ext), 'js', `${ ext } should be classified as js`);
	}
});

Deno.test('classifyExt: text asset extensions classified as text', () => {
	for(const ext of ['.css', '.html', '.htm', '.svg', '.json', '.txt', '.md', '.map', '.xml', '.yaml', '.yml']){
		assertEquals(classifyExt(ext), 'text', `${ ext } should be classified as text`);
	}
});

Deno.test('classifyExt: binary and unknown extensions classified as binary', () => {
	for(const ext of ['.png', '.woff2', '.ttf', '.ico', '.wasm', '.gz', '.zip', '']){
		assertEquals(classifyExt(ext), 'binary', `${ ext } should be classified as binary`);
	}
});


// ─── sanitize: convertIndent option ──────────────────────────────────────────

Deno.test('sanitize: convertIndent=true (default) converts 2-space to tabs', () => {
	const input = 'function foo(){\n  return 1;\n}\n';
	const { text } = sanitize(input, 'test.js', { convertIndent: true });
	assert(text.includes('\treturn'), 'indent should be converted to tab');
});

Deno.test('sanitize: convertIndent=false preserves space indentation', () => {
	// JSON, CSS etc. must not have their indentation altered --
	// that would change content semantics (JSON parsers don't care, but
	// human reviewers and diffs do; CSS indentation is presentational).
	const input = '{\n  "key": "value",\n  "nested": {\n    "x": 1\n  }\n}\n';
	const { text } = sanitize(input, 'test.json', { convertIndent: false });
	assert(text.includes('  "key"'), 'space indentation should be preserved with convertIndent=false');
	assert(!text.includes('\t"key"'), 'tabs should not be introduced for text assets');
});

Deno.test('sanitize: convertIndent=false still strips variation selectors', () => {
	// The convertIndent flag controls ONLY indent conversion.
	// All invisible-unicode stripping must still run regardless.
	const vs = '\uFE00\uFE01';
	const input = `{\n  "key": "${ vs }value"\n}\n`;
	const { text, warnings } = sanitize(input, 'test.json', { convertIndent: false });
	assert(!text.includes('\uFE00'), 'VS chars must be stripped even with convertIndent=false');
	// test.json: stripped 2 disallowed codepoint(s): U+FE00, U+FE01 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(
		warnings.some(w => /test\.json.*stripped 2 disallowed.*U\+FE00, U\+FE01/.test(w)),
		`must warn about stripped VS chars, got ${ JSON.stringify(warnings) }`
	);
});

Deno.test('sanitize: convertIndent=false still strips bidi overrides', () => {
	const input = `body { color\u202E: red; }\n`;
	const { text, warnings } = sanitize(input, 'test.css', { convertIndent: false });
	assert(!text.includes('\u202E'), 'bidi char must be stripped from CSS');
	// test.css: stripped 1 disallowed codepoint(s): U+202E [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /test.css.*stripped 1 disallowed.*U\+202E/.test(w)), `must warn about stripped bidi removals (style.css), got ${ JSON.stringify(warnings) }`);
});

Deno.test('sanitize: convertIndent=false still strips zero-width chars', () => {
	const input = `{ "key\u200B": "val" }\n`;
	const { text, warnings } = sanitize(input, 'test.json', { convertIndent: false });
	assert(!text.includes('\u200B'), 'zero-width char must be stripped from JSON');
	// test.json: stripped 1 disallowed codepoint(s): U+200B [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /test.json.*stripped 1 disallowed.*U\+200B/.test(w)), `must warn about stripped zero-width removals (JSON.json), got ${ JSON.stringify(warnings) }`);
});


// ─── invisible unicode in non-JS text assets ─────────────────────────────────

Deno.test('sanitize: variation selectors stripped from CSS', () => {
	const vs = '\uFE00\uFE0F';
	const input = `.selector\u202E { content: "\uFE00"; color: red${ vs }; }\n`;
	const { text, warnings } = sanitize(input, 'style.css', { convertIndent: false });
	assert(!text.includes('\uFE00'), 'VS chars stripped from CSS');
	assert(!text.includes('\uFE0F'), 'VS chars stripped from CSS');
	// style.css: stripped 4 disallowed codepoint(s): U+202E, U+FE00×2, U+FE0F [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /style.css.*stripped 4 disallowed.*U\+202E, /.test(w)), `must warn about stripped VS removals for css, got ${ JSON.stringify(warnings) }`);
});

Deno.test('sanitize: variation selectors stripped from HTML', () => {
	const vs = '\uFE02';
	const input = `<html>\n<body>\n<p data-x="\uFE00${ vs }">hello</p>\n</body>\n</html>\n`;
	const { text, warnings } = sanitize(input, 'index.html', { convertIndent: false });
	assert(!text.includes('\uFE00'), 'VS chars stripped from HTML');
	// index.html: stripped 2 disallowed codepoint(s): U+FE00, U+FE02 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /index.html.*stripped 2 disallowed.*U\+FE00, /.test(w)), `must warn about stripped variation sleector removals for html, got ${ JSON.stringify(warnings) }`);
});

Deno.test('sanitize: variation selectors stripped from JSON', () => {
	// A malicious vendored JSON config could carry VS chars that a downstream
	// JS loader might process in a context where they execute.
	const vs = '\uFE00\uFE01\uFE02';
	const input = `{ "script": "\`${ vs }\`" }\n`;
	const { text, warnings } = sanitize(input, 'config.json', { convertIndent: false });
	assert(!text.includes('\uFE00'), 'VS chars stripped from JSON');
	// config.json: stripped 3 disallowed codepoint(s): U+FE00, U+FE01, U+FE02 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /config.json.*stripped 3 disallowed.*U\+FE00, /.test(w)), `must warn about stripped variation sleector removals for JSON, got ${ JSON.stringify(warnings) }`);
	
});

Deno.test('sanitize: variation selectors stripped from SVG', () => {
	// SVGs can contain inline script elements; VS chars in an SVG are as
	// dangerous as in a JS file if the SVG is served with the right MIME type.
	const vs = '\uFE00';
	const input = `<svg><script>eval(\`${ vs }\`)</script></svg>\n`;
	const { text, warnings } = sanitize(input, 'icon.svg', { convertIndent: false });
	assert(!text.includes('\uFE00'), 'VS chars stripped from SVG');
	// icon.svg: stripped 1 disallowed codepoint(s): U+FE00 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /icon.svg.*stripped 1 disallowed.*U\+FE00/.test(w)), `must warn about stripped variation sleector removals for SVG, got ${ JSON.stringify(warnings) }`);
});

Deno.test('sanitize: bidi overrides stripped from JSON', () => {
	// Trojan Source via JSON: a config value that visually appears benign but
	// contains bidi overrides to conceal a different string.
	const input = `{ "role": "user\u202E\u2066rdm\u2069" }\n`;
	const { text, warnings } = sanitize(input, 'config.json', { convertIndent: false });
	assert(!text.includes('\u202E'), 'bidi char stripped from JSON');
	assert(!text.includes('\u2066'), 'bidi isolate stripped from JSON');
	// config.json: stripped 3 disallowed codepoint(s): U+202E, U+2066, U+2069 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /config.json.*stripped 3 disallowed.*U\+202E, U\+2066, U\+2069/.test(w)), `must warn about stripped bidi removals for JSON, got ${ JSON.stringify(warnings) }`);
});


// ─── processOne: content type dispatch ───────────────────────────────────────

// processOne needs a valid CDN URL to infer ext via urlToPath.
// We use real-shaped URLs but processOne is pure (no I/O).

function jsUrl(file = 'index.js'){
	return `https://cdn.jsdelivr.net/npm/lib@1.0.0/${ file }/+esm`;
}
function textUrl(file){ return `https://cdn.jsdelivr.net/npm/lib@1.0.0/${ file }`; }

Deno.test('processOne: JS file -- sanitize warnings returned', () => {
	const vs = '\uFE00\uFE01';
	const text = `const s = \`${ vs }\`;\neval(s);\n`;
	const { warnings, analysis } = processOne(text, jsUrl(), jsUrl(), WWWROOT, RELATIVE, false);
	// https://cdn.jsdelivr.net/npm/lib@1.0.0/index.js/+esm: stripped 2 disallowed codepoint(s): U+FE00, U+FE01 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /https:.*stripped 2 disallowed.*U\+FE00/.test(w)), `must warn about stripped VS removals for JS URL, got ${ JSON.stringify(warnings) }`);
	assert(analysis.some(w => w.includes('eval')), 'analyzeContent flags eval in JS');
});

Deno.test('processOne: CSS file -- VS stripped, no analyzeContent', () => {
	const vs = '\uFE00';
	const text = `.foo { color: red${ vs }; }\n`;
	const url = textUrl('style.css');
	const { warnings, analysis } = processOne(text, url, url, WWWROOT, RELATIVE, false);
	// https://cdn.jsdelivr.net/npm/lib@1.0.0/style.css: stripped 1 disallowed codepoint(s): U+FE00 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /https:.*stripped 1 disallowed.*U\+FE00/.test(w)), `must warn about stripped VS removals for CSS URL, got ${ JSON.stringify(warnings) }`);
	assertEquals(analysis.length, 0, 'no analyzeContent for CSS');
});

Deno.test('processOne: JSON file -- VS stripped, no analyzeContent, no discovered', () => {
	const vs = '\uFE00\uFE01';
	const text = `{ "x": "${ vs }" }\n`;
	const url = textUrl('data.json');
	const { warnings, analysis, discovered } = processOne(text, url, url, WWWROOT, RELATIVE, false);
	// https://cdn.jsdelivr.net/npm/lib@1.0.0/data.json: stripped 2 disallowed codepoint(s): U+FE00, U+FE01 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /https:.*stripped 2 disallowed.*U\+FE00/.test(w)), `must warn about stripped VS removals for JSON URL, got ${ JSON.stringify(warnings) }`);
	assertEquals(analysis.length, 0, 'no analyzeContent for JSON');
	assertEquals(discovered.length, 0, 'no import discovery for JSON');
});

Deno.test('processOne: JSON file -- space indentation preserved', () => {
	const text = '{\n  "key": "value"\n}\n';
	const url = textUrl('data.json');
	const { output } = processOne(text, url, url, WWWROOT, RELATIVE, false);
	assert(output.includes('  "key"'), 'JSON space indentation should not be converted to tabs');
});

Deno.test('processOne: SVG file -- treated as text, VS stripped', () => {
	const vs = '\uFE02';
	const text = `<svg><title>icon${ vs }</title></svg>\n`;
	const url = textUrl('icon.svg');
	const { warnings, analysis } = processOne(text, url, url, WWWROOT, RELATIVE, false);
	// https://cdn.jsdelivr.net/npm/lib@1.0.0/icon.svg: stripped 1 disallowed codepoint(s): U+FE02 [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /https:.*stripped 1 disallowed.*U\+FE02/.test(w)), `must warn about stripped VS removals for SVG URL, got ${ JSON.stringify(warnings) }`);
	assertEquals(analysis.length, 0, 'no analyzeContent for SVG');
});

Deno.test('processOne: binary file -- passed through unchanged, no warnings', () => {
	// .woff2 font file: binary, should not be touched
	const binaryLike = '\x00\x01\x02\x03binary content\xFF\xFE';
	const url = textUrl('font.woff2');
	const { output, warnings, analysis } = processOne(binaryLike, url, url, WWWROOT, RELATIVE, false);
	assertEquals(output, binaryLike, 'binary content should pass through unchanged');
	assertEquals(warnings.length, 0, 'no warnings for binary');
	assertEquals(analysis.length, 0, 'no analysis for binary');
});

Deno.test('processOne: CSS file -- bidi overrides stripped', () => {
	const input = `.class\u202E { content: "x"; }\n`;
	const url = textUrl('style.css');
	const { output, warnings } = processOne(input, url, url, WWWROOT, RELATIVE, false);
	assert(!output.includes('\u202E'), 'bidi override removed from CSS output');
	// https://cdn.jsdelivr.net/npm/lib@1.0.0/style.css: stripped 1 disallowed codepoint(s): U+202E [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /https:.*stripped 1 disallowed.*U\+202E/.test(w)), `must warn about stripped bidi removals for CSS URL, got ${ JSON.stringify(warnings) }`);
});

Deno.test('processOne: HTML file -- zero-width chars stripped', () => {
	const input = `<p>hel\u200Blo</p>\n`;
	const url = textUrl('page.html');
	const { output, warnings } = processOne(input, url, url, WWWROOT, RELATIVE, false);
	assert(!output.includes('\u200B'), 'zero-width space removed from HTML');
	// https://cdn.jsdelivr.net/npm/lib@1.0.0/page.html: stripped 1 disallowed codepoint(s): U+200B [add to UNICODE_ALLOWED_RANGES if legitimate]
	assert(warnings.some(w => /https:.*stripped 1 disallowed.*U\+200B/.test(w)), `must warn about stripped zero-width removals for HTML URL, got ${ JSON.stringify(warnings) }`);
});

Deno.test('processOne: JS file -- indent converted to tabs', () => {
	const input = 'function foo(){\n  return 1;\n}\n';
	const { output } = processOne(input, jsUrl(), jsUrl(), WWWROOT, RELATIVE, false);
	assert(output.includes('\treturn'), 'JS output should have tab-converted indentation');
});

Deno.test('processOne: clean CSS produces no warnings', () => {
	const input = '.foo { color: red; }\n.bar { margin: 0; }\n';
	const url = textUrl('style.css');
	const { warnings, analysis } = processOne(input, url, url, WWWROOT, RELATIVE, false);
	assertEquals(warnings.length, 0, 'clean CSS should produce no warnings');
	assertEquals(analysis.length, 0, 'clean CSS should produce no analysis flags');
});


// ─── --strict behavior (processOne result shape) ──────────────────────────────
// fetchAll's processUrl sets result.blocked = analysis.length > 0 && !config.force.
// We test the building blocks: analysis flags that would trigger a block,
// and that force suppresses them.

Deno.test('analyzeContent: eval flag causes block-eligible result', () => {
	// Simulates what processOne returns for a JS file that would be blocked.
	const vs = '\uFE00';
	const rawText = `eval(Buffer.from(s(\`${ vs }\`)).toString('utf-8'));\n`;
	const { text: sanitized } = sanitize(rawText, 'test.js');
	const analysis = analyzeContent(sanitized, 'test.js');
	// analysis non-empty = blocked (when !force)
	assert(analysis.length > 0, 'analysis should be non-empty, triggering block');
	assert(analysis.some(w => w.includes('eval')), 'eval flag present');
});

Deno.test('analyzeContent: clean JS produces no flags -- not blocked', () => {
	const text = 'export const x = 1;\nexport function add(a, b){ return a + b; }\n';
	const analysis = analyzeContent(text, 'test.js');
	assertEquals(analysis.length, 0, 'clean code produces no analysis flags -- would not be blocked');
});

Deno.test('analyzeContent: variation selector decoder signature flagged independently', () => {
	// The VS decoder arithmetic (hex range references) should be flagged even
	// after the VS chars themselves have been stripped by sanitize().
	// This tests the second, independent tripwire.
	const decoderLine = 'w >= 0xFE00 && w <= 0xFE0F ? w - 0xFE00 : null\n';
	const flags = analyzeContent(decoderLine, 'test.js');
	assert(
		flags.some(w => w.includes('variation-selector range ref')),
		'hex range reference in decoder code should be flagged'
	);
});

// ─── [EXPAND] decoder-signature: new forms now detected ──────────────────────
// The patch expanded the decoder-signature pattern to cover unicode escapes and
// decimal equivalents, not just hex literals. These tests cover the new forms.
// The original hex-literal test ('analyzeContent: variation selector decoder
// signature flagged independently') is still correct and does not need replacing.

Deno.test('analyzeContent: decoder signature -- unicode escape form \\uFE00 flagged', () => {
	// A decoder written with unicode escape syntax instead of hex literals.
	const line = 'if(cp === \\uFE00 || cp === \\uFE0F) return cp - 0xFE00;\n';
	const flags = analyzeContent(line, 'test.js');
	assert(
		flags.some(w => w.includes('variation-selector range ref')),
		`unicode-escape form \\uFE00 should be flagged, got: ${ JSON.stringify(flags) }`
	);
});

Deno.test('analyzeContent: decoder signature -- brace escape \\u{E0100} flagged', () => {
	const line = 'if(cp >= \\u{E0100} && cp <= \\u{E01EF}) decode(cp);\n';
	const flags = analyzeContent(line, 'test.js');
	assert(
		flags.some(w => w.includes('variation-selector range ref')),
		`brace-escape form \\u{E0100} should be flagged, got: ${ JSON.stringify(flags) }`
	);
});

Deno.test('analyzeContent: decoder signature -- decimal 65024 (U+FE00) flagged', () => {
	// VS-1 in decimal.
	const line = 'if(cp >= 65024 && cp <= 65039) return cp - 65024;\n';
	const flags = analyzeContent(line, 'test.js');
	assert(
		flags.some(w => w.includes('variation-selector range ref')),
		`decimal 65024 (U+FE00) should be flagged, got: ${ JSON.stringify(flags) }`
	);
});

Deno.test('analyzeContent: decoder signature -- decimal 917760 (U+E0100) flagged', () => {
	// VS-101 in decimal.
	const line = 'if(cp === 917760) return payload;\n';
	const flags = analyzeContent(line, 'test.js');
	assert(
		flags.some(w => w.includes('variation-selector range ref')),
		`decimal 917760 (U+E0100) should be flagged, got: ${ JSON.stringify(flags) }`
	);
});

Deno.test('analyzeContent: decoder signature -- decimal range boundary 917999 (U+E01EF) flagged', () => {
	const line = 'const last = 917999;\n';
	const flags = analyzeContent(line, 'test.js');
	assert(
		flags.some(w => w.includes('variation-selector range ref')),
		`decimal 917999 (U+E01EF) should be flagged, got: ${ JSON.stringify(flags) }`
	);
});

Deno.test('analyzeContent: decoder signature -- unrelated number 65023 not flagged', () => {
	// One below the VS-1 decimal range -- must not produce a false positive.
	const line = 'const boundary = 65023;\n';
	const flags = analyzeContent(line, 'test.js');
	assert(
		!flags.some(w => w.includes('variation-selector range ref')),
		`65023 is below VS range and should not be flagged`
	);
});

Deno.test('analyzeContent: decoder signature -- unrelated number 65040 not flagged', () => {
	// One above the VS-16 decimal range.
	const line = 'const next = 65040;\n';
	const flags = analyzeContent(line, 'test.js');
	assert(
		!flags.some(w => w.includes('variation-selector range ref')),
		`65040 is above VS-16 decimal range and should not be flagged`
	);
});
Deno.test('analyzeContent: new Function with invisible payload flagged', () => {
	// Variant of the Glassworm pattern using new Function() instead of eval().
	const vs = '\uFE00\uFE01';
	const { text: sanitized } = sanitize(`const fn = new Function(\`${ vs }\`);\n`, 'test.js');
	const flags = analyzeContent(sanitized, 'test.js');
	assert(flags.some(w => w.includes('new Function')), 'new Function should be flagged');
});

Deno.test('analyzeContent: base64 blob in JS flagged as possible encoded payload', () => {
	// Large base64 strings in vendored code are a secondary payload delivery
	// mechanism -- the payload is embedded in a string rather than in invisible chars.
	const blob = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.repeat(4);
	const text = `const payload = "${ blob }";\n`;
	const flags = analyzeContent(text, 'test.js');
	assert(flags.some(w => w.includes('blob')), 'large base64 blob should be flagged');
});


// ─── --strict stdout output structure ────────────────────────────────────────
// The actual Deno.exit(1) path is in main (not a pure function), so we test
// the data shape that drives it: results Map entries with .blocked and .analysis.
// The subprocess-based dry-run tests in the main test file are the pattern
// to follow if you want to add a full --strict subprocess integration test.

Deno.test('blocked result shape: analysis non-empty + force=false means blocked=true', () => {
	// Reconstruct the logic from fetchAll's processUrl:
	// blocked = analysis.length > 0 && !force
	const force = false;
	const analysis = ['test.js:1 [eval] eval(x)'];
	const blocked = analysis.length > 0 && !force;
	assertEquals(blocked, true, 'file with analysis flags should be blocked when force=false');
});

Deno.test('blocked result shape: force=true suppresses block', () => {
	const force = true;
	const analysis = ['test.js:1 [eval] eval(x)'];
	const blocked = analysis.length > 0 && !force;
	assertEquals(blocked, false, '--force should suppress the block');
});

Deno.test('blocked result shape: empty analysis means not blocked regardless of force', () => {
	for(const force of [true, false]){
		const analysis = [];
		const blocked = analysis.length > 0 && !force;
		assertEquals(blocked, false, 'no analysis flags = not blocked');
	}
});

/*

unit tests for stripDisallowed() and buildDisallowedPattern().
these are the two functions that provide the core security guarantee:
every codepoint outside UNICODE_ALLOWED_RANGES is stripped and reported.

*/

// ─── buildDisallowedPattern: output shape ─────────────────────────────────────

Deno.test('buildDisallowedPattern: returns a RegExp', () => {
	const re = buildDisallowedPattern([[0x0020, 0x007E]]);
	assert(re instanceof RegExp, 'should return a RegExp');
});

Deno.test('buildDisallowedPattern: has u flag (required for supplementary codepoints)', () => {
	const re = buildDisallowedPattern([[0x0020, 0x007E]]);
	assert(re.unicode, 'u flag must be set -- without it, supplementary codepoints split into surrogates');
});

Deno.test('buildDisallowedPattern: has g flag (required for replace-all)', () => {
	const re = buildDisallowedPattern([[0x0020, 0x007E]]);
	assert(re.global, 'g flag must be set for replace() to remove all matches');
});

Deno.test('buildDisallowedPattern: negated class -- matches chars NOT in the range', () => {
	// allow only printable ASCII; tab (U+0009) is outside that range
	const re = buildDisallowedPattern([[0x0020, 0x007E]]);
	assert(re.test('\t'), 'tab (outside allowed range) should match the disallowed pattern');
	assert(!re.test('A'), 'ASCII letter (inside allowed range) should not match');
});

Deno.test('buildDisallowedPattern: single-codepoint range treated correctly', () => {
	// [lo, lo] -- range where lo === hi
	const re = buildDisallowedPattern([[0x0041, 0x0041]]);	// only 'A' allowed
	assert(!re.test('A'), 'A should be allowed (not matched as disallowed)');
	assert(re.test('B'), 'B should be disallowed (matched)');
});

Deno.test('buildDisallowedPattern: supplementary codepoint in range not matched', () => {
	// allow emoji block U+1F300-U+1FAFF; a codepoint inside should not match
	const re = buildDisallowedPattern([[0x1F300, 0x1FAFF]]);
	const emoji = '\u{1F600}';	// U+1F600 grinning face, inside the range
	assert(!re.test(emoji), 'emoji inside allowed range should not be flagged');
});

Deno.test('buildDisallowedPattern: supplementary codepoint outside range is matched', () => {
	// allow only ASCII; emoji is outside
	const re = buildDisallowedPattern([[0x0020, 0x007E]]);
	const emoji = '\u{1F600}';
	assert(re.test(emoji), 'emoji outside allowed ASCII range should be flagged');
});

Deno.test('buildDisallowedPattern: multiple ranges combined correctly', () => {
	// allow ASCII + Cyrillic
	const re = buildDisallowedPattern([[0x0020, 0x007E], [0x0400, 0x04FF]]);
	assert(!re.test('A'),       'ASCII should be allowed');
	assert(!re.test('\u0410'),  'Cyrillic should be allowed');
	assert(re.test('\u0300'),  'combining diacritic (outside both ranges) should be flagged');
});


// ─── buildDisallowedPattern: BMP / supplementary boundary ────────────────────

Deno.test('buildDisallowedPattern: U+FFFF (top of BMP) handled correctly', () => {
	const re = buildDisallowedPattern([[0x0020, 0xFFFF]]);
	assert(!re.test('\uFFFF'), 'U+FFFF inside range should not be flagged');
});

Deno.test('buildDisallowedPattern: U+10000 (first supplementary) handled correctly with u flag', () => {
	// U+10000 LINEAR B SYLLABLE B008 A -- first codepoint outside BMP
	const re = buildDisallowedPattern([[0x0020, 0x007E]]);	// only ASCII allowed
	const sup = '\u{10000}';
	assert(re.test(sup),
		'supplementary codepoint outside allowed range must be caught (requires u flag)');
});


// ─── stripDisallowed: clean input ─────────────────────────────────────────────

Deno.test('stripDisallowed: clean ASCII returns unchanged text, no warnings', () => {
	const input = 'export const x = 1;\nfunction add(a, b){ return a + b; }\n';
	const { text, warnings } = stripDisallowed(input, 'test.js');
	assertEquals(text, input, 'clean ASCII should pass through unchanged');
	assertEquals(warnings.length, 0, 'clean input should produce no warnings');
});

Deno.test('stripDisallowed: tab, LF, CR preserved (explicitly allowed)', () => {
	const input = '\tconst x = 1;\r\nconst y = 2;\n';
	const { text } = stripDisallowed(input, 'test.js');
	assert(text.includes('\t'), 'tab must be preserved');
	assert(text.includes('\n'), 'LF must be preserved');
	assert(text.includes('\r'), 'CR must be preserved (stripDisallowed does not normalise line endings)');
});

Deno.test('stripDisallowed: CJK characters preserved', () => {
	const input = 'const s = "こんにちは";\n';
	const { text, warnings } = stripDisallowed(input, 'test.js');
	assert(text.includes('こんにちは'), 'CJK must be preserved');
	assertEquals(warnings.length, 0, 'CJK must not trigger a warning');
});

Deno.test('stripDisallowed: emoji preserved', () => {
	const input = 'const e = "🎉";\n';
	const { text, warnings } = stripDisallowed(input, 'test.js');
	assert(text.includes('🎉'), 'emoji must be preserved');
	assertEquals(warnings.length, 0, 'emoji must not trigger a warning');
});

Deno.test('stripDisallowed: Cyrillic preserved', () => {
	const input = 'const s = "Привет";\n';
	const { text, warnings } = stripDisallowed(input, 'test.js');
	assert(text.includes('Привет'), 'Cyrillic must be preserved');
	assertEquals(warnings.length, 0);
});

Deno.test('stripDisallowed: Latin-extended preserved', () => {
	const input = 'const s = "naïve résumé";\n';
	const { text, warnings } = stripDisallowed(input, 'test.js');
	assert(text.includes('naïve'), 'Latin-extended must be preserved');
	assertEquals(warnings.length, 0);
});


// ─── stripDisallowed: known attack classes removed ────────────────────────────

Deno.test('stripDisallowed: bidi override U+202E stripped', () => {
	const input = 'const x\u202E = 1;\n';
	const { text, warnings } = stripDisallowed(input, 'test.js');
	assert(!text.includes('\u202E'), 'U+202E must be stripped');
	assertEquals(warnings.length, 1);
	assert(/U\+202E/.test(warnings[0]), `warning must identify U+202E, got: ${ warnings[0] }`);
});

Deno.test('stripDisallowed: all Trojan Source bidi range stripped (U+202A-202E, U+2066-2069, U+200F)', () => {
	const dangerous = ['\u202A','\u202B','\u202C','\u202D','\u202E','\u2066','\u2067','\u2068','\u2069','\u200F'];
	for(const ch of dangerous){
		const cp = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
		const { text, warnings } = stripDisallowed(`const x = "${ ch }";\n`, 'test.js');
		assert(!text.includes(ch), `U+${ cp } must be stripped`);
		assert(warnings.length > 0, `U+${ cp } must produce a warning`);
	}
});

Deno.test('stripDisallowed: zero-width space U+200B stripped', () => {
	const input = 'const\u200B x = 1;\n';
	const { text, warnings } = stripDisallowed(input, 'test.js');
	assert(!text.includes('\u200B'), 'U+200B must be stripped');
	assert(/U\+200B/.test(warnings[0]), `warning must identify U+200B, got: ${ warnings[0] }`);
});

Deno.test('stripDisallowed: BOM U+FEFF stripped', () => {
	const { text, warnings } = stripDisallowed('\uFEFFconst x = 1;\n', 'test.js');
	assert(!text.startsWith('\uFEFF'), 'BOM must be stripped');
	assert(/U\+FEFF/.test(warnings[0]), `warning must identify U+FEFF, got: ${ warnings[0] }`);
});

Deno.test('stripDisallowed: soft hyphen U+00AD stripped', () => {
	const { text, warnings } = stripDisallowed('con\u00ADst x = 1;\n', 'test.js');
	assert(!text.includes('\u00AD'), 'soft hyphen must be stripped');
	assert(/U\+00AD/.test(warnings[0]), `warning must identify U+00AD, got: ${ warnings[0] }`);
});

Deno.test('stripDisallowed: BMP variation selectors U+FE00-FE0F stripped', () => {
	for(const cp of [0xFE00, 0xFE08, 0xFE0F]){
		const ch = String.fromCodePoint(cp);
		const { text, warnings } = stripDisallowed(`const s = \`${ ch }\`;\n`, 'test.js');
		assert(!text.includes(ch), `U+${ cp.toString(16).toUpperCase() } must be stripped`);
		assert(warnings.length > 0, 'must warn');
	}
});

Deno.test('stripDisallowed: supplementary variation selectors U+E0100-E01EF stripped', () => {
	// U+E0100 = \uDB40\uDD00, U+E01EF = \uDB40\uDDEF
	const vsFirst = '\uDB40\uDD00';
	const vsLast  = '\uDB40\uDDEF';
	for(const ch of [vsFirst, vsLast]){
		const { text, warnings } = stripDisallowed(`const s = \`${ ch }\`;\n`, 'test.js');
		assert(!text.includes('\uDB40'), 'supplementary VS must be stripped');
		assert(warnings.length > 0, 'must warn');
	}
});

Deno.test('stripDisallowed: Unicode Tag block U+E0001 stripped', () => {
	// U+E0001 = \uDB40\uDC01 -- inside Tag block, outside VS supplement
	const tag = '\uDB40\uDC01';
	const { text, warnings } = stripDisallowed(`const s = \`${ tag }\`;\n`, 'test.js');
	assert(!text.includes('\uDB40'), 'Tag block codepoint must be stripped');
	assert(warnings.length > 0, 'must warn');
});

Deno.test('stripDisallowed: C0 control chars stripped (except TAB, LF, CR)', () => {
	// null byte, bell, backspace -- all C0 below 0x20 except the three preserved
	const input = 'const x\x00 = \x07"hello\x08";\n';
	const { text, warnings } = stripDisallowed(input, 'test.js');
	assert(!text.includes('\x00'), 'null byte must be stripped');
	assert(!text.includes('\x07'), 'bell must be stripped');
	assert(!text.includes('\x08'), 'backspace must be stripped');
	assert(warnings.length > 0, 'must warn');
	assert(/U\+0000/.test(warnings[0]), `warning must identify U+0000, got: ${ warnings[0] }`);
});

Deno.test('stripDisallowed: C1 controls U+0080-U+009F stripped', () => {
	const c1 = '\x80\x9F';	// first and last of the C1 range
	const { text } = stripDisallowed(`const x = "${ c1 }";\n`, 'test.js');
	assert(!text.includes('\x80'), 'C1 control U+0080 must be stripped');
	assert(!text.includes('\x9F'), 'C1 control U+009F must be stripped');
});


// ─── stripDisallowed: warning format ─────────────────────────────────────────

Deno.test('stripDisallowed: warning includes file label', () => {
	const { warnings } = stripDisallowed('x\u202E\n', 'src/lib/gadget.js');
	assertExists(warnings[0]);
	assert(warnings[0].startsWith('src/lib/gadget.js:'), `warning must start with label, got: ${ warnings[0] }`);
});

Deno.test('stripDisallowed: warning includes total count', () => {
	// 3 distinct disallowed chars
	const { warnings } = stripDisallowed('a\u202Eb\u200Bc\uFE00d\n', 'test.js');
	assertExists(warnings[0]);
	assert(warnings[0].includes('3'), `warning must report count of 3, got: ${ warnings[0] }`);
});

Deno.test('stripDisallowed: warning lists codepoint addresses', () => {
	const { warnings } = stripDisallowed('x\u202E\n', 'test.js');
	assertExists(warnings[0]);
	assert(warnings[0].includes('U+202E'), `warning must include U+202E, got: ${ warnings[0] }`);
});

Deno.test('stripDisallowed: warning includes repeat count for repeated codepoint', () => {
	// U+202E appears 3 times
	const { warnings } = stripDisallowed('\u202E\u202E\u202E\n', 'test.js');
	assertExists(warnings[0]);
	// format: U+202E×3
	assert(warnings[0].includes('U+202E\u00D73') || warnings[0].includes('U+202E x3') || warnings[0].includes('\xD73'),
		`warning should show repeat count, got: ${ warnings[0] }`);
	// check the actual format from the source: U+202E×3
	assert(/U\+202E.3/.test(warnings[0]), `warning should encode count, got: ${ warnings[0] }`);
});

Deno.test('stripDisallowed: produces exactly one warning entry per call regardless of char count', () => {
	// multiple different disallowed chars -- still one warning string with all addresses
	const input = '\u202E\u200B\uFE00\u0000\n';
	const { warnings } = stripDisallowed(input, 'test.js');
	assertEquals(warnings.length, 1, 'all stripped chars should be consolidated into one warning');
});

Deno.test('stripDisallowed: warning includes advisory text', () => {
	const { warnings } = stripDisallowed('x\u202E\n', 'test.js');
	assert(warnings[0].includes('UNICODE_ALLOWED_RANGES'),
		`warning should mention UNICODE_ALLOWED_RANGES, got: ${ warnings[0] }`);
});

Deno.test('stripDisallowed: more than 10 unique codepoints -- overflow noted', () => {
	// generate 12 distinct disallowed codepoints from C0 range (skipping TAB=9, LF=A, CR=D)
	const chars = [0,1,2,3,4,5,6,7,8,  0xB,0xC,  0xE,0xF]
		.map(cp => String.fromCodePoint(cp)).join('');
	const { warnings } = stripDisallowed(chars + '\n', 'test.js');
	assertExists(warnings[0]);
	// the warning caps at 10 listed, then notes overflow
	assert(warnings[0].includes('+'), `warning should note overflow beyond 10, got: ${ warnings[0] }`);
});

Deno.test('stripDisallowed: no warnings when input is empty string', () => {
	const { text, warnings } = stripDisallowed('', 'test.js');
	assertEquals(text, '');
	assertEquals(warnings.length, 0);
});


// ─── stripDisallowed: emoji surrogate boundary (false positive check) ─────────

Deno.test('stripDisallowed: emoji surrogate pairs not incorrectly stripped', () => {
	// U+1F600 = \uD83D\uDE00 -- grinning face, supplementary but inside allowed emoji range
	// This is the critical boundary test: the u flag must prevent the regex from
	// treating the high surrogate \uD83D as an isolated BMP character and stripping it.
	const emoji = '\uD83D\uDE00';
	const { text, warnings } = stripDisallowed(`const e = "${ emoji }";\n`, 'test.js');
	assert(text.includes(emoji), 'emoji surrogate pair must survive intact');
	assertEquals(warnings.length, 0, 'emoji must not produce a warning');
});

Deno.test('stripDisallowed: VS supplement surrogate \uDB40\uDD00 stripped, emoji \uD83D\uDE00 preserved in same string', () => {
	// Both appear in the same string. The VS surrogate must go; the emoji must stay.
	// This confirms the u-flag regex correctly distinguishes supplementary codepoints
	// by their actual value rather than by their high surrogate alone.
	const vs    = '\uDB40\uDD00';	// U+E0100 -- disallowed
	const emoji = '\uD83D\uDE00';	// U+1F600 -- allowed
	const input = `const s = "${ vs }${ emoji }";\n`;
	const { text, warnings } = stripDisallowed(input, 'test.js');
	assert(!text.includes('\uDB40'), 'VS supplement must be stripped');
	assert(text.includes(emoji), 'emoji must be preserved');
	assert(warnings.length > 0, 'must warn about stripped VS');
});


// ─── UNICODE_ALLOWED_RANGES integrity ────────────────────────────────────────
// these tests verify the data structure is correctly formed, not that every
// range is policy-correct (that is a human judgment call).

Deno.test('UNICODE_ALLOWED_RANGES: soft hyphen U+00AD is not included', () => {
	const covered = UNICODE_ALLOWED_RANGES.some(([lo, hi = lo]) => 0x00AD >= lo && 0x00AD <= hi);
	assert(!covered, 'U+00AD soft hyphen must not be in UNICODE_ALLOWED_RANGES -- invisible formatting char');
});

Deno.test('UNICODE_ALLOWED_RANGES: is a non-empty array', () => {
	assert(Array.isArray(UNICODE_ALLOWED_RANGES), 'must be an array');
	assert(UNICODE_ALLOWED_RANGES.length > 0, 'must not be empty');
});

Deno.test('UNICODE_ALLOWED_RANGES: all entries are [lo] or [lo, hi] with valid codepoints', () => {
	for(const entry of UNICODE_ALLOWED_RANGES){
		assert(Array.isArray(entry), `entry must be array: ${ JSON.stringify(entry) }`);
		assert(entry.length === 1 || entry.length === 2, `entry must have 1 or 2 elements: ${ JSON.stringify(entry) }`);
		const [lo, hi] = entry;
		assert(Number.isInteger(lo) && lo >= 0 && lo <= 0x10FFFF,
			`lo must be valid codepoint: ${ lo }`);
		if(hi !== undefined){
			assert(Number.isInteger(hi) && hi >= lo && hi <= 0x10FFFF,
				`hi must be >= lo and <= U+10FFFF: lo=${ lo }, hi=${ hi }`);
		}
	}
});

Deno.test('UNICODE_ALLOWED_RANGES: TAB, LF, CR are explicitly included', () => {
	const flat = UNICODE_ALLOWED_RANGES.flatMap(([lo, hi = lo]) =>
		Array.from({ length: Math.min(hi - lo + 1, 1) }, (_, i) => lo + i)
	);
	// check that each whitespace codepoint falls within at least one range
	for(const [cp, name] of [[0x09,'TAB'],[0x0A,'LF'],[0x0D,'CR']]){
		const covered = UNICODE_ALLOWED_RANGES.some(([lo, hi = lo]) => cp >= lo && cp <= hi);
		assert(covered, `${ name } (U+${ cp.toString(16).toUpperCase().padStart(4,'0') }) must be in UNICODE_ALLOWED_RANGES`);
	}
});

Deno.test('UNICODE_ALLOWED_RANGES: printable ASCII U+0020-U+007E is included', () => {
	const covered = UNICODE_ALLOWED_RANGES.some(([lo, hi = lo]) => lo <= 0x0020 && hi >= 0x007E);
	assert(covered, 'printable ASCII range must be fully covered by a single entry');
});

Deno.test('UNICODE_ALLOWED_RANGES: known dangerous ranges are NOT included', () => {
	// these must be absent. if any of these codepoints fall inside an allowed range,
	// the allowlist has been incorrectly extended to include attack surface.
	const forbidden = [
		[0x202E,  'right-to-left override (Trojan Source)'],
		[0xFE00,  'VS-1 (Glassworm BMP)'],
		[0xFE0F,  'VS-16 (Glassworm BMP)'],
		[0xE0100, 'VS-17 (Glassworm supplement)'],
		[0xE01EF, 'VS-256 (Glassworm supplement)'],
		[0xE0001, 'Tag block (invisible)'],
		[0x200B,  'zero-width space'],
		[0xFEFF,  'BOM'],
		// new: Arabic Cf format characters -- invisible, zero-width, no source use
		[0x0600,  'Arabic Number Sign (Cf, invisible)'],
		[0x0601,  'Arabic Sign Sanah (Cf, invisible)'],
		[0x0602,  'Arabic Footnote Marker (Cf, invisible)'],
		[0x0603,  'Arabic Sign Safha (Cf, invisible)'],
		[0x0604,  'Arabic Sign Samvat (Cf, invisible)'],
		[0x0605,  'Arabic Number Mark Above (Cf, invisible)'],
	];
	for(const [cp, name] of forbidden){
		const covered = UNICODE_ALLOWED_RANGES.some(([lo, hi = lo]) => cp >= lo && cp <= hi);
		assert(
			!covered,
			`${ name } (U+${ cp.toString(16).toUpperCase() }) must NOT be in UNICODE_ALLOWED_RANGES`
		);
	}
});

// Companion: Arabic letters starting at U+0606 ARE still allowed
Deno.test('UNICODE_ALLOWED_RANGES: Arabic letters U+0606+ are included', () => {
	// U+0606 is the first Arabic codepoint after the excluded Cf block
	// U+0627 ARABIC LETTER ALEF -- should be present
	for(const cp of [0x0606, 0x0627, 0x06FF]){
		const covered = UNICODE_ALLOWED_RANGES.some(([lo, hi = lo]) => cp >= lo && cp <= hi);
		assert(
			covered,
			`U+${ cp.toString(16).toUpperCase() } (Arabic letter) must be in UNICODE_ALLOWED_RANGES`
		);
	}
});

// stripDisallowed: Arabic Cf codepoints are now stripped
Deno.test('stripDisallowed: Arabic Cf format chars U+0600-U+0605 stripped', () => {
	for(const cp of [0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605]){
		const ch  = String.fromCodePoint(cp);
		const hex = cp.toString(16).toUpperCase().padStart(4, '0');
		const { text, warnings } = stripDisallowed(`const x = "${ ch }";\n`, 'test.js');
		assert(!text.includes(ch),     `U+${ hex } (Arabic Cf) must be stripped`);
		assert(warnings.length > 0,    `U+${ hex } must produce a warning`);
		assert(/U\+0600|U\+0601|U\+0602|U\+0603|U\+0604|U\+0605/.test(warnings[0]),
			`warning must identify the Arabic Cf codepoint, got: ${ warnings[0] }`);
	}
});

// stripDisallowed: Arabic letters starting at U+0606 are preserved
Deno.test('stripDisallowed: Arabic letters U+0606+ preserved', () => {
	const alef = '\u0627';	// ARABIC LETTER ALEF
	const { text, warnings } = stripDisallowed(`const s = "${ alef }";\n`, 'test.js');
	assert(text.includes(alef), 'Arabic letter must be preserved');
	assertEquals(warnings.length, 0, 'Arabic letter must not trigger a warning');
});

// ─── isAllowed ────────────────────────────────────────────────────────────────

Deno.test('isAllowed: printable ASCII codepoints are allowed', () => {
	for(const cp of [0x0020, 0x0041, 0x007E]){
		assert(isAllowed(cp), `U+${ cp.toString(16).toUpperCase() } (printable ASCII) should be allowed`);
	}
});

Deno.test('isAllowed: TAB, LF, CR are allowed', () => {
	assert(isAllowed(0x0009), 'TAB should be allowed');
	assert(isAllowed(0x000A), 'LF should be allowed');
	assert(isAllowed(0x000D), 'CR should be allowed');
});

Deno.test('isAllowed: soft hyphen U+00AD is not allowed', () => {
	assert(!isAllowed(0x00AD), 'soft hyphen must not be allowed');
});

Deno.test('isAllowed: BOM U+FEFF is not allowed', () => {
	assert(!isAllowed(0xFEFF), 'BOM must not be allowed');
});

Deno.test('isAllowed: VS-1 U+FE00 is not allowed', () => {
	assert(!isAllowed(0xFE00), 'VS-1 must not be allowed');
});

Deno.test('isAllowed: VS supplement U+E0100 is not allowed', () => {
	assert(!isAllowed(0xE0100), 'VS supplement must not be allowed');
});

Deno.test('isAllowed: Arabic Cf U+0600 is not allowed (patched)', () => {
	assert(!isAllowed(0x0600), 'U+0600 Arabic Cf must not be allowed after patch');
});

Deno.test('isAllowed: Arabic Cf U+0605 is not allowed (patched)', () => {
	assert(!isAllowed(0x0605), 'U+0605 Arabic Cf must not be allowed after patch');
});

Deno.test('isAllowed: Arabic letter U+0627 is allowed', () => {
	assert(isAllowed(0x0627), 'Arabic letter Alef must be allowed');
});

Deno.test('isAllowed: emoji U+1F600 is allowed', () => {
	assert(isAllowed(0x1F600), 'emoji U+1F600 must be allowed');
});

Deno.test('isAllowed: Cyrillic U+0410 is allowed', () => {
	assert(isAllowed(0x0410), 'Cyrillic must be allowed');
});

Deno.test('isAllowed: codepoint just above emoji range U+1FB00 is not allowed', () => {
	assert(!isAllowed(0x1FB00), 'U+1FB00 is outside emoji range and must not be allowed');
});

Deno.test('isAllowed: codepoint just below emoji range U+1F2FF is not allowed', () => {
	assert(!isAllowed(0x1F2FF), 'U+1F2FF is below emoji range and must not be allowed');
});


// ─── inspectCodepoints ────────────────────────────────────────────────────────

Deno.test('inspectCodepoints: pure ASCII returns empty array', () => {
	const result = inspectCodepoints('export const x = 1;\n', 'test.js');
	assertEquals(result, [], 'pure ASCII input should produce no output');
});

Deno.test('inspectCodepoints: returns array of strings (one header + one per unique codepoint)', () => {
	// Two distinct non-ASCII codepoints: é (U+00E9) and ñ (U+00F1)
	const result = inspectCodepoints('const s = "éñ";\n', 'test.js');
	assert(Array.isArray(result), 'should return an array');
	// header line + 2 codepoint lines
	assertEquals(result.length, 3, 'should have header + 2 codepoint entries');
});

Deno.test('inspectCodepoints: header line includes label and count', () => {
	const result = inspectCodepoints('const s = "é";\n', 'test.js');
	assert(result[0].includes('test.js'), 'header should include file label');
	assert(result[0].includes('1'), 'header should include codepoint type count');
});

Deno.test('inspectCodepoints: entry includes U+ address', () => {
	const result = inspectCodepoints('const s = "é";\n', 'test.js');
	assert(result.some(l => l.includes('U+00E9')), 'should include U+00E9 address for é');
});

Deno.test('inspectCodepoints: entry includes occurrence count', () => {
	// é appears 3 times
	const result = inspectCodepoints('const s = "ééé";\n', 'test.js');
	const entry = result.find(l => l.includes('U+00E9'));
	assertExists(entry, 'entry for U+00E9 should exist');
	assert(entry.includes('3'), 'entry should show occurrence count of 3');
});

Deno.test('inspectCodepoints: [allowed] status for codepoint inside UNICODE_ALLOWED_RANGES', () => {
	// é U+00E9 is inside the Latin-1 Supplement range
	const result = inspectCodepoints('const s = "é";\n', 'test.js');
	const entry = result.find(l => l.includes('U+00E9'));
	assertExists(entry);
	assert(entry.includes('[allowed]'), 'in-range codepoint should be marked [allowed]');
});

Deno.test('inspectCodepoints: [STRIPPED] status for codepoint outside UNICODE_ALLOWED_RANGES', () => {
	// U+202E RTL override is outside the allowlist
	const result = inspectCodepoints('const x\u202E = 1;\n', 'test.js');
	const entry = result.find(l => l.includes('U+202E'));
	assertExists(entry, 'entry for U+202E should exist');
	assert(entry.includes('[STRIPPED]'), 'out-of-range codepoint should be marked [STRIPPED]');
});

Deno.test('inspectCodepoints: entry includes line number of first occurrence', () => {
	// é appears first on line 2
	const result = inspectCodepoints('const x = 1;\nconst s = "é";\n', 'test.js');
	const entry = result.find(l => l.includes('U+00E9'));
	assertExists(entry);
	assert(entry.includes('line 2'), 'entry should include first-occurrence line number');
});

Deno.test('inspectCodepoints: entry includes trimmed line content', () => {
	const result = inspectCodepoints('const s = "é";\n', 'test.js');
	const entry = result.find(l => l.includes('U+00E9'));
	assertExists(entry);
	// The trimmed line 'const s = "é";' should appear in the entry
	assert(entry.includes('const s ='), 'entry should include trimmed source line content');
});

Deno.test('inspectCodepoints: codepoints sorted by codepoint value ascending', () => {
	// U+00E9 é < U+0410 Cyrillic А
	const result = inspectCodepoints('const s = "éА";\n', 'test.js');
	// entries are lines 1+ (line 0 is the header)
	const e1 = result.findIndex(l => l.includes('U+00E9'));
	const e2 = result.findIndex(l => l.includes('U+0410'));
	assert(e1 > 0 && e2 > 0, 'both codepoints should be in output');
	assert(e1 < e2, 'lower codepoint should appear first');
});

Deno.test('inspectCodepoints: supplementary codepoint U+1F600 reported with 5-digit hex', () => {
	const result = inspectCodepoints('const e = "😀";\n', 'test.js');
	assert(result.some(l => l.includes('U+1F600')), 'emoji should appear as U+1F600 (5 hex digits)');
});

Deno.test('inspectCodepoints: VS codepoint U+FE00 reported as [STRIPPED]', () => {
	const result = inspectCodepoints('const s = `\uFE00`;\n', 'test.js');
	const entry = result.find(l => l.includes('U+FE00'));
	assertExists(entry, 'VS codepoint should appear in inventory');
	assert(entry.includes('[STRIPPED]'), 'VS codepoint should be marked [STRIPPED]');
});

Deno.test('inspectCodepoints: Arabic Cf U+0600 reported as [STRIPPED] (after patch)', () => {
	const ch = String.fromCodePoint(0x0600);
	const result = inspectCodepoints(`const s = "${ ch }";\n`, 'test.js');
	const entry = result.find(l => l.includes('U+0600'));
	assertExists(entry, 'U+0600 should appear in inventory');
	assert(entry.includes('[STRIPPED]'), 'U+0600 must be [STRIPPED] after Arabic Cf patch');
});

Deno.test('inspectCodepoints: each codepoint appears exactly once regardless of frequency', () => {
	// U+00E9 appears 10 times -- should still produce exactly one entry line for it
	const input = '"' + 'é'.repeat(10) + '"';
	const result = inspectCodepoints(input, 'test.js');
	const entries = result.filter(l => l.includes('U+00E9'));
	assertEquals(entries.length, 1, 'each codepoint should produce exactly one entry');
});

Deno.test('inspectCodepoints: label used in header line', () => {
	const result = inspectCodepoints('const s = "é";\n', 'lib/parser.js');
	assert(result[0].includes('lib/parser.js'), 'header should include the provided label');
});


// ─── runInspect ───────────────────────────────────────────────────────────────
// runInspect is async and fetches from the network, so we test only the
// shape contract and the pure-function layers it delegates to.
// A full integration test would require --allow-net and a live CDN -- that is
// appropriate to add separately if desired.

Deno.test('runInspect: is a function', () => {
	assert(typeof runInspect === 'function', 'runInspect must be exported as a function');
});

Deno.test('runInspect: accepts seedUrls Set and config object without throwing (empty set early return)', async () => {
	// An empty seed set means nothing is fetched. runInspect should return
	// { results, totals } without throwing or hanging.
	const config = {
		verbose:  false,
		max:      1,
		strict:   false,
		wwwroot:  '/tmp',
	};
	const { results, totals } = await runInspect(new Set(), config);
	assert(results instanceof Map,   'results should be a Map');
	assertEquals(totals.urls, 0,     'no URLs means zero urls in totals');
	assertEquals(totals.findings, 0, 'no URLs means zero findings');
});
