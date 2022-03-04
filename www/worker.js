const excludePattern = /ANY-THING/i;
const excludePathname = new Set([
	
]);
const staticAssets = new Set([
	'/sour-dough.js',
	'/wildtype/lit.js',
	'/wildtype/lit/html.js',
//	'/wildtype/construct-style-sheets-polyfill.js',
	'/wildtype/@vaadin/router/dist/vaadin-router.js'
]);
const scope = '/sourdough/?';
const version = 'v0.0.x';
const cacheNames = {
	www: `${ scope }www-${ version }`
	,fetch: `${ scope }fetch-${ version }`
}

self.addEventListener('install', async event => {
	event.waitUntil(
		caches
			.open(cacheNames.www)
			.then(cache => cache.addAll(staticAssets))
	);
});

self.addEventListener('message', event=>{
	const { data, origin } = event;
	// SECURITY REQUIRED origin must match
	if(origin !== self.origin || !data){
		console.warn(`reject origin`,{event});
		return;
	}

	// cache a request for the next visit, typically already in browser cache ie the current page
	const { cache } = data;
	if(cache){
		cacheData(new Request(cache));
	}
});

self.addEventListener('fetch', event => {
	// header Service-Worker-Allowed: / 
	// path matching scope
	const {request} = event;
	const url = new URL(request.url);
	if(
		url.origin === self.origin
		&& !excludePattern.test(url) 
		&& !excludePathname.has(url.pathname)
	){
		//console.warn(`[worker] 🪣 check cache for ${ url.pathname }`, {url});
		event.respondWith(cacheData(request));
	} else {
		console.warn(`[worker] 📮🛸 bypass cache for ${ url.pathname }`, {url});
		fetch(request).then(responseOk);
	}
});

self.addEventListener('update', (event) => {
	console.warn(event.type, {event});
});

// housekeeping
self.addEventListener('activate', (event) => {
	const current = new Set(Object.values(cacheNames));
	event.waitUntil(
		caches.keys().then((keyList) => {
			// allow multiple workers, each managing their own scope
			// all caches matching our specific prefix we'll manage
			const keys = keyList.filter(key=>{
				return key.startsWith(scope)
			});
			return Promise.all(keys.map((key) => {
				// remove all that aren't current
				if (!current.has(key)) {
					return caches.delete(key);
				}
			}));
		})
	);
});


function responseFailed({response={}, request={}}){
	const fix = new Response(JSON.stringify({error:'failed to get this content, sorry'}), {headers: {'Content-Type': 'application/json;charset=utf-8'}, status: response.status || 503 /* 503 unavailable */});
	// TODO possibly more appropriate specific response-types?
	// 'text/plain;charset=UTF-8'
	fix.fake = true;
	fix.response = response;

	console.warn(`responseFailed()`,{request,response,fix});

	return fix;
}

function responseOk(response){
	// must have a status and must not be opaqueredirect to reject on not-ok
	if(!response.ok && response.status && 'opaqueredirect' !== response.type){
		return Promise.reject(response);
	}
	return response;
}

async function cacheData(request) {
	let response = await caches.match(request);
	return response || networkFirst(request);
}

async function networkFirst(request) {
	const cache = await caches.open(cacheNames.fetch);

	try {
		const response = await fetch(request).then(responseOk).catch(response=> responseFailed({response, request}) );
		const url = new URL(request.url);
		const { status } = response;
		if(!response.fake && url.origin === self.origin && status >= 200 && status < 300) {
		// TODO fix problem with caching into fetch items in other cache, etc
			cache.put(request, response.clone());
		};
		return response;
	} catch (error){
		return await cache.match(request) || responseFailed();
	}

}
