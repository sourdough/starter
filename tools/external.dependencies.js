export const dependencies = [
// structuredClone for safari, chrome <98
'https://unpkg.com/@ungap/structured-clone@1.2.1/esm/index.js',
'https://unpkg.com/construct-style-sheets-polyfill@3.1.0/dist/adoptedStyleSheets.js',
'https://unpkg.com/element-internals-polyfill@1.3.12/dist/index.js',
//
'https://cdn.jsdelivr.net/npm/@lit/localize@0.12.2/lit-localize.js',
'https://unpkg.com/@lit/context@1.1.3/index.js?module',
'https://unpkg.com/@lit/task@1.0.1/index.js',
// 
'https://cdn.jsdelivr.net/npm/lit@3.2.1/index.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/async-append.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/async-replace.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/cache.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/choose.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/class-map.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/guard.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/if-defined.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/join.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/keyed.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/live.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/map.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/range.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/ref.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/repeat.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/style-map.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/template-content.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/unsafe-html.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/unsafe-svg.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/until.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/directives/when.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.2.1/html.js/+esm',
// features
/* 2.0 not worth the trouble? https://unpkg.com/@vaadin/router@2.0.0/dist/router.js?module
Cannot generate module for @vaadin/router@2.0.0/dist/router.js
SyntaxError: unknown: Support for the experimental syntax 'classProperties' isn't currently enabled (50:12):
> 50 |   location = createLocation({ resolver: this });
     |            ^
Add @babel/plugin-proposal-class-properties (https://git.io/vb4SL) to the 'plugins' section of your Babel config to enable transformation.
this also errors, giving up on supporting someone else's software
'https://cdn.jsdelivr.net/npm/@vaadin/router@2.0.0/dist/index.js/+esm',
*/
'https://unpkg.com/@vaadin/router@1.7.5/dist/vaadin-router.js',
'https://unpkg.com/pyscript@1.0.6/index.js?module',
];

console.warn(`loaded depenency list ${ dependencies.length }`);
