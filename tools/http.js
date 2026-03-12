/*
	simple http service for local development;
	SPA behavior when no file extension present (returns the wwwroot index)
	uses Deno 🦕 more at https://deno.land

	a few examples to run it:

		PORT=8777 && deno run --allow-read=./ --allow-net=127.0.0.1:$PORT ./tools/http.js -port=$PORT -www=./www

		deno run --allow-read=./ --allow-net=127.0.0.1:8000 ./tools/http.js -www=./

		deno run --watch ...

	https://hono.dev/docs/getting-started/deno
	https://docs.deno.com/api/deno/#program-lifecycle
*/
import * as paf from "jsr:@std/path";
import { serveStatic } from "jsr:@hono/hono/deno";
import { Hono } from "jsr:@hono/hono";
import args from './args.js';

const script = new URL(import.meta.url).pathname;

const config = {
	hostname: 'localhost'
	,port: 8777
	,www: './www'
	,index: 'index.html'
	// default expiration caching (minimum 1 second)
	,expires: 'private, max-age=1, s-maxage=1'
};

args(Deno.args, config, `http options...`);

config.root = config.www.startsWith('.') ? paf.resolve(Deno.cwd(), config.www) : paf.resolve(config.www);

config.userAgent = `Deno/${Deno.version.deno} V8/${Deno.version.v8} TS/${Deno.version.typescript} ${Deno.build.target}`;

console.log(`
@sourdoug/starter
	👾 🛰️ 🛸 🚀 http... 🗺️ 📜 📜 📜 📜 📜

	pid ${ Deno.pid }
	$0 ${ script }
	cwd ${ Deno.cwd() }

usage like:
	deno run --allow-read=./ --allow-net=127.0.0.1:8000 ./tools/http.js -www=./www

overwrite any option with pattern "-name='value'"

`, {config});

function log(status='000', VERB='GUESS', what='', who='?', client='~', where='...', other='-'){
	console.log(`${ (new Date).toISOString() } ${ status } "${ VERB } ${ what }" ${ who } "${ client }" ${ where } ${ other }`);
}

function getIP(req){
	const headers = req.raw.headers;
	return headers.get('x-forwarded-for')?.split(',')[0]?.trim()
		|| headers.get('x-real-ip')
		|| headers.get('cf-connecting-ip')
		|| '?.0.0.?';
}

const app = new Hono();

// timing
app.use('*', async (c, next) => {
	const start = Date.now();
	await next();
	c.res.headers.set('X-Response-Time', `${ Date.now() - start }ms`);
});

// logger
app.use('*', async (c, next) => {
	await next();
	const time = c.res.headers.get('X-Response-Time');
	const ip = getIP(c.req);
	log(c.res.status, c.req.method, c.req.url, '?', c.req.header('user-agent') ?? '~', ip, time);
});

// cache control on all responses
app.use('*', async (c, next) => {
	await next();
	c.res.headers.set('Cache-Control', config.expires);
});

// static file serving — root resolved to absolute path
app.use('*', serveStatic({ root: config.root }));

// SPA fallback: any unmatched route with no file extension serves the index
app.notFound(async (c) => {
	const ext = paf.extname(new URL(c.req.url).pathname);
	if(!ext){
		try{
			const index = await Deno.readFile(paf.join(config.root, config.index));
			return c.html(new TextDecoder().decode(index));
		}catch{
			// index not found, fall through to 404
		}
	}
	return c.text('404 Not Found', 404);
});

// unhandled errors
app.onError((err, c) => {
	const status = (err.status ?? 500);
	const msg = (err.message || '').slice(0, 3000);

	c.res.headers.set('Cache-Control', config.expires);

	if(err.expose){
		c.res.headers.set('X-appmsg', msg);
	}

	const ip = getIP(c.req);
	log(status, c.req.method, c.req.url, '?', c.req.header('user-agent') ?? '~', ip);

	return c.html(`<!doctype html>
<html><body>
<p>${ status } ${ err.message || 'Internal Server Error' }</p>
</body></html>`, status);
});

let _server = null;

function exiting(){
	log('000', 'CLOSE', `http://${ config.hostname }:${ config.port }`, '?', config.userAgent);
	Deno.exit();
}

globalThis.addEventListener('beforeunload', exiting);
Deno.addSignalListener("SIGINT", exiting);
Deno.addSignalListener("SIGHUP", exiting);

log('000', 'START', `http://${ config.hostname }:${ config.port }`, '?', config.userAgent);
console.log(`
@sourdoug/starter

	hostname: "${ config.hostname }"
	open http://${ config.hostname }:${ config.port }
`);

_server = Deno.serve({
	hostname: config.hostname,
	port: Number(config.port),
}, app.fetch);

await _server.finished;
