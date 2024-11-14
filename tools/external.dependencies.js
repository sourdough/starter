export const dependencies = [
// structuredClone for safari, chrome <98
'https://unpkg.com/@ungap/structured-clone@1.2.0/esm/index.js',
'https://unpkg.com/construct-style-sheets-polyfill@3.1.0/dist/adoptedStyleSheets.js',
'https://unpkg.com/element-internals-polyfill@1.3.11/dist/index.js',
//
'https://cdn.jsdelivr.net/npm/@lit/localize@0.12.1/lit-localize.js',
'https://unpkg.com/@lit/context@1.1.2/index.js?module',
'https://unpkg.com/@lit/task@1.0.1/index.js',
// 
'https://cdn.jsdelivr.net/npm/lit@3.1.4/index.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/async-append.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/async-replace.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/cache.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/choose.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/class-map.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/guard.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/if-defined.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/join.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/keyed.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/live.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/map.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/range.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/ref.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/repeat.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/style-map.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/template-content.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/unsafe-html.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/unsafe-svg.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/until.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/directives/when.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.1.4/html.js/+esm',
// features
'https://unpkg.com/@vaadin/router@1.7.5/dist/vaadin-router.js',
'https://unpkg.com/pyscript@1.0.6/index.js?module',
];

console.warn(`loaded depenency list ${ dependencies.length }`);
