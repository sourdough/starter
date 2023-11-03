export const dependencies = [
// structuredClone for safari, chrome <98
'https://unpkg.com/@ungap/structured-clone@1.2.0/esm/index.js',
'https://unpkg.com/construct-style-sheets-polyfill@3.1.0/dist/adoptedStyleSheets.js',
'https://unpkg.com/element-internals-polyfill@1.3.9/dist/index.js',
//
'https://cdn.jsdelivr.net/npm/@lit/localize@0.12.1/lit-localize.js',
'https://unpkg.com/@lit/context@1.0.1/index.js?module',
'https://unpkg.com/@lit/task@1.0.0/index.js',
// 
'https://cdn.jsdelivr.net/npm/lit@3.0.2/index.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/async-append.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/async-replace.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/cache.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/choose.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/class-map.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/guard.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/if-defined.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/join.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/keyed.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/live.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/map.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/range.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/ref.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/repeat.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/style-map.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/template-content.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/unsafe-html.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/unsafe-svg.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/until.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/directives/when.js/+esm',
'https://cdn.jsdelivr.net/npm/lit@3.0.2/html.js/+esm',
// features
'https://unpkg.com/@vaadin/router@1.7.5/dist/vaadin-router.js',
'https://unpkg.com/@supabase/supabase-js@2.38.4/dist/module/index.js?module',
];

console.warn(`loaded depenency list ${ dependencies.length }`);
