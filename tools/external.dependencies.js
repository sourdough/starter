export const dependencies = [
// structuredClone for safari, chrome <98
'https://unpkg.com/@ungap/structured-clone@1.2.0/esm/index.js',
'https://unpkg.com/construct-style-sheets-polyfill@3.1.0/dist/adoptedStyleSheets.js',
'https://unpkg.com/element-internals-polyfill@1.3.9/dist/index.js',
//
'https://cdn.jsdelivr.net/npm/@lit/localize@0.12.0/lit-localize.js',
// lit v3.0.0 on 2023-10-25
'https://cdn.jsdelivr.net/npm/lit@3.0.0/index.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/async-append.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/async-replace.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/cache.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/choose.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/class-map.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/guard.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/if-defined.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/join.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/keyed.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/live.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/map.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/range.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/ref.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/repeat.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/style-map.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/template-content.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/unsafe-html.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/unsafe-svg.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/until.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/when.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.0/html.js/+esm',
// features
'https://unpkg.com/@vaadin/router@1.7.5/dist/vaadin-router.js',
'https://unpkg.com/@supabase/supabase-js@2.38.3/dist/module/index.js?module',
];

console.warn(`loaded depenency list ${ dependencies.length }`);
