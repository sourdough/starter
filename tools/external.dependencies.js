export const dependencies = [
// structuredClone for safari, chrome <98
'https://unpkg.com/@ungap/structured-clone@0.3.4/esm/index.js',
'https://unpkg.com/construct-style-sheets-polyfill@3.1.0/dist/adoptedStyleSheets.js',
'https://unpkg.com/element-internals-polyfill@1.0.3/dist/index.js',
// 
'https://unpkg.com/@lit/localize@0.11.2/lit-localize.js?module',
// 2.2.0 @ 26-Feb-2022
'https://unpkg.com/lit@2.2.0?module',
'https://unpkg.com/lit@2.2.0/directives/async-append.js?module',
'https://unpkg.com/lit@2.2.0/directives/async-replace.js?module',
'https://unpkg.com/lit@2.2.0/directives/cache.js?module',
'https://unpkg.com/lit@2.2.0/directives/choose.js?module',
'https://unpkg.com/lit@2.2.0/directives/class-map.js?module',
'https://unpkg.com/lit@2.2.0/directives/if-defined.js?module',
'https://unpkg.com/lit@2.2.0/directives/join.js?module',
'https://unpkg.com/lit@2.2.0/directives/keyed.js?module',
'https://unpkg.com/lit@2.2.0/directives/guard.js?module',
'https://unpkg.com/lit@2.2.0/directives/ref.js?module',
'https://unpkg.com/lit@2.2.0/directives/repeat.js?module',
'https://unpkg.com/lit@2.2.0/directives/style-map.js?module',
'https://unpkg.com/lit@2.2.0/directives/unsafe-html.js?module',
'https://unpkg.com/lit@2.2.0/directives/until.js?module',
'https://unpkg.com/lit@2.2.0/html.js?module',
'https://unpkg.com/lit@2.2.0/directives/live.js?module',
'https://unpkg.com/lit@2.2.0/directives/map.js?module',
'https://unpkg.com/lit@2.2.0/directives/range.js?module',
'https://unpkg.com/lit@2.2.0/directives/when.js?module',
'https://unpkg.com/lit@2.2.0/directives/template-content.js?module',
'https://unpkg.com/lit@2.2.0/directives/unsafe-svg.js?module',
// features
'https://unpkg.com/@vaadin/router@1.7.4/dist/vaadin-router.js?module',
];

console.warn(`loaded depenency list ${ dependencies.length }`);
