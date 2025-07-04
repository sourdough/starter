/*
simple http service for local development;
SPA behavior when no file extension present (returns the wwwroot index)
uses Deno 🦕 more at https://deno.land

a few example to run it:

PORT=8777 && deno run --allow-read=./ --allow-net=127.0.0.1:$PORT ./tools/http.js -port=$PORT -www=./www

deno run --allow-read=./ --allow-net=127.0.0.1:8000 ./tools/http.js -www=./

TODO reload on file watching patterns

https://deno.land/x/oak
https://deno.land/manual/runtime/program_lifecycle
https://doc.deno.land/builtin/stable

EOL.LF .CRLF see https://deno.land/std/fs
*/
import * as paf from "jsr:@std/path";
import args from './args.js';
import { Application, Router, HttpError, send, Status } from "jsr:@oak/oak";

const script = new URL(import.meta.url).pathname;
const config = {
	host: '127.0.0.1'
	,port: 8777
	,www: './www'
	,index: 'index.html'
	// default expiration caching (minimum 1 second);
	,expires: 'private, max-age=1, s-maxage=1'
};
args(Deno.args, config, `http options...`)

/*
const env = Deno.env.toObject();
 * */

// NOTE resolve(Deno.cwd(), '/root') => '/root'
config.root = paf.resolve(Deno.cwd(), config.www);
config.userAgent = `Deno/${Deno.version.deno} V8/${Deno.version.v8} TS/${Deno.version.typescript} ${Deno.build.target}`;

console.log(`pid ${ Deno.pid }
$0 ${ script }
cwd ${ Deno.cwd() }

usage like:
$ deno run --allow-read=./ --allow-net=127.0.0.1:8000 ./tools/http.js -www=./www

overwrite any option with pattern "-name='value'"

${ JSON.stringify(config, (key, val)=>{
	switch(typeof val){
	case 'object':
		if(val && val.constructor.name !== 'Object') return val.toString();
		return val;
	break;
	case 'function':
		return val.toString();
	break;
	default:
		return val;
	}
}, '\t') }
}

`);

const app = new Application(config);
const router = new Router();

const charset = '; charset=utf-8';
const mimetypes = {
	css: `text/css${ charset }`
	,ico: `image/vnd.microsoft.icon`
	,jpg: `image/jpeg`
	,js: `text/javascript${ charset }`
	,json: `application/json${ charset }`
	,pdf: `application/pdf${ charset }`
	,txt: `text/plain${ charset }`
	,html: `text/html${ charset }`
	// application/csp-report as JSON
};

// general error handling including unhandled middleware errors (500)
app.use(async (context, next) => {
	const {response, request} = context;
	try{
		await next();
	}catch(err){
		let status = err instanceof HttpError ? err.status : 500;
		const { pathname } = request.url;
		// adjust response to fit requested mimetype
		let ext = paf.extname(pathname).toLowerCase();

		if(404 === status && !ext){ // && !pathname.endsWith('/')){
			// single-page-app SPA pattern
			await send(context, config.index, config);
			response.status = 200;
		}else{
			// respect error status codes set by other middleware
			if((response.status || 0) < 400){
				response.status = status;
			};
			const ip = request.headers.get("x-forwarded-for")?.split(',')[0]?.trim() || request.headers.get("x-real-ip") || request.headers.get("cf-connecting-ip") || '0.0.0.0';
			log(status, request.method, request.url.href, request.user, request.headers.get('user-agent'), ip);

			let type = mimetypes[ ext ] || mimetypes[ ( ext = 'html' ) ];
			response.type = type;

			// short caches on errors
			response.headers.set('Cache-Control', config.expires);

			const msg = (err.message || '').slice(0, 3000);

			if(err.expose){
				response.headers.set('X-appmsg', msg);
			};

			// setting a body resets the status to 200 oak/issues/448
			const _status = response.status;
			// send an appropriate response
			switch(ext){
			case 'html':
			response.body = `<!doctype html>
<html><body>
<p>${status} ${ Status[status] || 'Internal Server Error' }</p>
</body></html>`;
			break;
			default:
			response.body = '';
			}
			// restore status
			response.status = _status;
		}
	}
});

function log(status='000', VERB='GUESS', what='', who='?', client='~', where='...', other='-'){
	console.log(`${ (new Date).toISOString() } ${ status } "${ VERB } ${ what }" ${ who } "${ client }" ${ where } ${ other }`);
}

// Logger
app.use(async (context, next) => {
	await next();
	const request = context.request;
	const time = context.response.headers.get('X-Response-Time');
	const ip = request.headers.get("x-forwarded-for")?.split(',')[0]?.trim() || request.headers.get("x-real-ip") || request.headers.get("cf-connecting-ip") || '0.0.0.0';
	log(context.response.status, request.method, request.url, request.user, request.headers.get('user-agent'), ip, time);
});

app.use(async (context, next) => {
	const start = Date.now();
	await next();
	const msg = Date.now() - start;
	context.response.headers.set('X-Response-Time', `${msg}ms`);
});


app.use(router.routes());
app.use(router.allowedMethods());

// static content
app.use(async context => {
	// config = {root: paf.resolve(Deno.cwd(), '....'), index: 'index.html'}
	await send(context, context.request.url.pathname, config);
});

app.addEventListener('error', (event)=>{
	console.error(event.error);
	log('000', 'ERROR', `${ event.error }`, undefined, config.userAgent);
});
let _server = null;
app.addEventListener('listen', (server)=>{
	_server = server;
	log('000', 'START', `${ server.secure ? 'https':'http' }://${ server.hostname || 'localhost' }:${ server.port }`, undefined, config.userAgent);
});

function exiting(){
	const server = _server;
	log('000', 'CLOSE', `${ server.secure ? 'https':'http' }://${ server.hostname || 'localhost' }:${ server.port }`, undefined, config.userAgent);
	Deno.exit();
}
globalThis.addEventListener('beforeunload', exiting);
Deno.addSignalListener("SIGINT",exiting);
Deno.addSignalListener("SIGHUP",exiting);

await app.listen(config);

