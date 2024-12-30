/*
load a list of urls from a file/stdin and dump them into the destination (creating directories as needed);
* currently only supports unpkg.com
* see deno install info at https://deno.land as needed then
* run from root of www project, like cd ~/path/to/wwwroot with:

$ deno run --allow-env --allow-read=./ --allow-write=./www/wildtype/ --allow-net='cdn.jsdelivr.net' ./tools/external.importer.js -file=./tools/external.dependencies.js -dump=./www/wildtype/

$ deno run --allow-env --allow-read=./ --allow-write=./www/wildtype/ --allow-net='cdn.jsdelivr.net,raw.githubusercontent.com' https://raw.githubusercontent.com/sourdough/starter/main/tools/external.importer.js -file=./tools/external.dependencies.js -dump=./www/wildtype/ --verbose=true


file external.dependencies.js has something like (https://github.com/sourdough/starter/blob/main/tools/external.dependencies.js):

export const dependencies = [
	'https://cdn.jsdelivr.net/npm/lit@3.0.0/index.js/+esm',
	'https://cdn.jsdelivr.net/npm/lit@3.0.0/directives/async-append.js/+esm',
];


TODOs
* call out 404 errors (non-200), recently happened with vaadin router where the file changed from vaadin-router.js to index.js
* add feature for reporting latest major, minor, point releases avaialable for a given list of urls; show status for all the urls requested
* strip explicit not-allowed characters from content before saving, report removed characters
* add feature for package.json to print out file list from dependency values
* possibly add integrity checks (for unpkg ?meta option provides json .integrity field on any file) for some type of reporting, if that has value (needs more complete definition); perhaps include SRI output to file for other features/applications
*/
// https://deno.land/std/path/mod.ts
// https://deno.land/std/fs/mod.ts
// import * as paf from "https://jsr.io/@std/path/0.225.2/posix/mod.ts";
// import * as fs from "https://jsr.io/@std/fs/0.229.3/mod.ts";
import * as paf from "jsr:@std/path/posix";
import * as fs from "jsr:@std/fs";

let fetch_count = 0;
const time = Date.now();
const script = new URL(import.meta.url).pathname;
// NOTE Deno.env requires --allow-env flag
const pwd = Deno.env.get('PWD');
const config = {
	verbose: false,
	max: 5,
	file: './external.dependencies.js',
	dump: './www/external/',
	wwwroot: pwd,
	help: false,
	outdated: false,
	versions: false,

	// TODO read a package.json file and output a list of urls for a cdn
	package: '',
};

Deno.args.reduce(function _options_(config, arg, i){
	// allow -name=value or -name:value, with any leading '-'
	const parts = arg.match(/^-+([a-z][a-z0-9]+)(?:[=:]?(.+))?/i);
	if(parts){
		const [all, name, value = ''] = parts;
		// can only set predefined properties
		if(config[name] === undefined){
			return config;
		}

		let val = value.trim();
		switch(typeof config[ name ]){
		case 'number':
			val = Number(val);
			if(isNaN(val)){
				console.warn(`skip invalid option ${ name }, expected a number and instead got "${value}" as ${ val }`);
				return config;
			}
			config[ name ] = val;
		break;
		case 'boolean':
			if(val && /^(?:0|false)/i.test(val)){
				config[ name ] = false;
			}else if(val !== ''){
				config[ name ] = Boolean(val);
			}else{
				// having the option present suggests making it true
				config[ name ] = true;
			}
		break;
		default:
			config[ name ] = val;;
		};
	}else if(/^(?:http)/i.test(arg)){
	// currently only handle http urls
		queue.add(arg.trim());
	}

	return config;

}, config);

console.log(`config`,{cwd:Deno.cwd(), ...config});

const dump = paf.resolve(paf.resolve(config.wwwroot), config.dump);
const relative = './' + paf.relative(config.wwwroot, dump);
const queue = new Set();
const active = new Set();
const dictionary = {};
const urls = new Set();
const rewrites = [];
const unver = {};

if(config.file){
	const file = paf.resolve(config.file);
	if(file.endsWith('.js')){
		await import(file).then(res=>{
			res.dependencies.forEach(url=>{
				if(!url || !url.startsWith('http')) return;
				queue.add(url);
			});
		}).catch(res=>{
			console.warn(res);
			config.help = true;
		});
	}
}

if(!queue.size || !config.dump || config.help){
	console.log(`
	external.importer help
	retrieve a list of urls, save them locally, resolve imports

	usage like (see https://deno.land for setup info, etc):
	$ deno run --allow-env --allow-read=./ --allow-write=./lib/external --allow-net='unpkg.com' ./tools/external.importer.js -file='./lib/external.dependencies.js' -dump=./lib/external

	optional files
	$ deno run --allow-net --allow-env --allow-read ./tools/external.importer.js url1 url2

	options begin with '-' ${ Object.entries(config).map(([k,v])=>`-${k}='${v}' (${typeof v})`).join(', ') }

	--verbose
	--versions
	--outdated
	--help

	${ config.file ? `NOTE file was empty: ${ config.file }`:'' }
	${ !config.dump ? `NOTE no destination provided by 'dump'`:'' }
	`);

	Deno.exit(0);
}else if(config.versions){
	console.log(`versions for ${ queue.size } items`);
	
	const vers = new Map();
	const list = versions(queue).map(
		({url, href, pathname, name, version, path, prefix, suffix, base})=>{
			if(!name) console.warn(`ambiguous name "${ name }"`);
			let v = vers.get(name);
			if(!v){
				v = {list: new Set(), base, for: []};
				vers.set(name, v);
			}
			v.list.add(version);
			v.for.push(href);

			return {href, name, version, pathname, path, prefix, suffix, base, req: `${ base }${ path }`};
		});
	if(config.verbose) console.log(list);
	console.log(vers);

	Deno.exit(0);
}else if(config.outdated){
	console.log(`checking versions for ${ queue.size } items`);

//console.warn(`versionDiff`,versionDiff([ 1, 2, 0 ], [ 1, 2, 0 ]));
//Deno.exit(0);
	const reqs = new Map();
	const vers = new Map();
	const list = versions(queue).map(
		({url, href, pathname, name, version, path, prefix, suffix, base})=>{
			if(!name) console.warn(`ambiguous name "${ name }"`);

			let v = vers.get(name);
			if(!v){
				v = {list: new Set(), base, for: []};
				vers.set(name, v);
				reqs.set(base, null);
			}
			v.list.add(version);
			v.for.push(href);

			return {href, name, version, path, base, req: `${ base }${ path }`};
		});
	if(config.verbose) console.log(list);

	for (const v of vers){
		const [name, ver] = v;
		console.log(name, ver.base);
		let req = reqs.get(ver.base);
		if(!req){
			req = fetch(ver.base)
			.then(async (res)=>{
				let latest;
				if(res.redirected){
					latest = hrefVersion(res.url);
				}else{
					const text = await res.text();
					const part = text.match(/[\s\S]Original file: ([^\s]+)/)?.[1] ?? res.url;
					const url = new URL(part, res.url);
					latest = hrefVersion(url.href);
				}
				ver.latest = latest;
				ver._res = res;
				return ver;
			})
			.catch(console.error)
			;

			reqs.set(ver.base, req);
		}
		ver._req = req;
	}
	await Promise.allSettled(reqs.values());

	console.log(`
done with ${reqs.size} items
	`, );

	const toUpdate = [];

	vers.forEach((val,key)=>{
		const vers = Array.from(val.list).map(vvversion).filter(v=>v.length >= 3);
		vers.sort(versionDiff);
		const latest = vvversion(val.latest.version);
		const last = vers[vers.length - 1];
		const mostRecentCheck = vers.length ? versionDiff(latest, last) : Infinity;
		const isMostRecent = mostRecentCheck === 0;
		const base = val.base;
		const { ok, redirected, status, url } = val._res;
		if(config.verbose) console.log({name:key, versions:vers.map(v=>v.join('.')),latest:latest.join('.'),mostRecentCheck,isMostRecent, base, url, ok, redirected, status, for:val.for});
		if(!isMostRecent) toUpdate.push({base, url, latest:latest.join('.'), for:val.for});
	});
	if(toUpdate.length){
		console.log(`please update:`, toUpdate);
	}else{
		console.log(`everything looks current (use -verbose option for more details)`);
	}

	Deno.exit(0);
}else{

	const list = await progress();

	console.log(
		{config},
		`${urls.size} urls in ${ Date.now() - time }ms (${ list.size } items)`
	);
}

function hrefVersion(href){
	//https://unpkg.com/@supabase/supabase-js@2.38.4/dist/umd/supabase.js
	const url = new URL(href);
	let pathname, all, prefix, suffix, name, version, path;
	pathname = url.pathname.replace(/^\/npm\//,'/').replace(/\/\+esm$/,'');
	[all, prefix=''] = url.pathname.match(/^(\/(?:npm|gh)\b)/) ?? [];
	[all, suffix=''] = url.pathname.match(/(\/\+esm)$/) ?? [];
	[all, name = '', version = '', path = ''] = pathname.match(/^\/(.+)@(\d+\.\d+\.\d+)(.*)/) ?? [];

	const base = url.origin + ( version ? `${prefix}/${ name }` : `${prefix}${pathname}` );

	return {url, href, pathname, name, version, path, prefix, suffix, base};
}
function versions(list=queue){
	return Array.from(list).map(hrefVersion);
};


function advance(dep){
	active.delete(dep.req);
}

function progress(){
	const { verbose, max } = config;
	if(verbose){
		console.warn('progress...', queue.size, active.size, max);
	}
	while(queue.size && (active.size < max)){
		const [url] = queue;
		queue.delete(url);
		if(dictionary[url]){
			if(verbose){
				console.warn(`dictionary has ${url}`);
			}
			continue;
		}
		const dep = req(url);
		dictionary[url] = dep;
		urls.add(dep);
		active.add(dep.req);
		if(verbose){
			console.log(`get ${url}`);
		}
	}

	return active.size ? Promise.all(Array.from(active))
		.then(deps=>{
			if(verbose){
				console.log('success', deps.length);
			}
			deps.forEach(advance);
			return progress();
		})
		.catch(err=>{
			if(verbose){
				console.warn('failure', err);
			}
			return Promise.reject(err);
		})
		: Promise.resolve(urls)
		;
}

function req(url){
	const dep = {req: null, res: null, body: '', url};
	fetch_count += 1;
	console.log(`${ fetch_count } ${ url }`);
	dep.req = fetch(url)
		.then(res=>{
			dep.res = res;
			// resolves from redirect? map that too
			dictionary[res.url] = dep;
			// return text....promises.... then dep;
			return res.text().then(async function(txt){
				dep.text = txt;
				const rewrite = await rewriter(txt, res.url, url);
				dep.body = rewrite;
				return dep;
			});
		})
		.catch(res=>{
			dep.res = res;
			console.error(res);
			console.warn(dep);
			return dep;//Promise.reject(dep);
		})
		;
	return dep;
}

/* currently written specific to unpkg.com urls:

	unversioned convert to 0.0.0

	/@vanillawc/wc-markdown/themes/prism-okaidia.css

	'https://unpkg.com/vanilla-colorful@0.6.2/rgba-color-picker.js?module',
	'https://unpkg.com/@vaadin/router@1.7.4?module',

	"https://cdn.jsdelivr.net/npm/lit@3.0.0/index.js/+esm",
	not sure what to do with content ./npm/lit/3.0.0/index.js/_esm

	clean url and derive values
	/thing@1.2.3... /thing@^1.2.3... /@org/thing@1.2.3...
	-> unversioned:   -> /thing... /@org/thing...
	-> versioned:     -> /thing/1.2.3... /@org/thing/1.2.3...
	-> name, version: -> thing, 1.2.3; @org/thing, 1.2.3

 */
function urlToPath(url){
	const parts = url.pathname.replace(/[?#].*$/,'').replace(/^\/npm\//,'/').replace(/\/\+esm$/,'').replace(/[^@\/a-z0-9._-]/gi, '_').match(/^\/(.+)@_?([0-9]+\.[0-9]+\.[0-9]+)(.*)$/i);
	if(!parts){
		// fail fast
		throw new Error(`unexpected url pattern "${ url }" is unlike /name@1.2.3/path`);
	}
	const [all, name, version, rest] = parts;
	// ./name...
	const unversioned = `./${ name }${ rest }`;
	// ./name/1.2.3...
	const versioned = `./${ name }/${ version }${ rest }`;
	const ext = paf.extname(rest).toLowerCase();
	const www = "/" + paf.relative(config.wwwroot, paf.resolve(config.wwwroot, relative, ext.endsWith('.js') ? versioned : (unversioned + '.js')));
	const wwwbasename = paf.basename(www);
	const wwwext = paf.extname(www).toLowerCase();

	const wwwversioned = "/" + paf.relative(config.wwwroot, paf.resolve(config.wwwroot, relative, versioned)) + (ext === '' ? '/'+wwwbasename:'');

	const semver = vvversion(version);
	return {
		unversioned,
		versioned,
		name,
		version,
		ext,
		wwwbasename,
		wwwext,
		www,
		wwwversioned,
		semver,
		path: url.pathname,
	};
}

// pass off for parsing for imports... queue those found, rewrite body text expecting to use saved results... write output to dump
// TODO create digest for file
async function rewriter(txt, url, oururl){
	const { verbose } = config;
	const modulePattern = /((?:import|export)\s*(?:[^\"\'\n\r;]+\s*from\s*)?)[\"\']([^\"\']+)[\'\"]/g;

	const url1 = new URL(oururl);
	const p1 = urlToPath(url1);
	const url2 = new URL(url);
	const p2 = urlToPath(url2);
//console.warn({url1,p1,url2,p2});
	// include source in top comment
	// TODO strip and report unknown/disallowed characters
	const output = p2.ext !== '.js' ? txt : `/* ${ url } */ ` + txt.replace(modulePattern, function(all, first, modl){
		const _url = new URL(modl, url);
		const { path, unversioned, versioned, name, version, ext, www, wwwbasename, wwwext, wwwversioned } = urlToPath(_url);

		// first section simply adds urls (imports/exports) to queue and adjusts for what the path will become locally
		if(/^https?:/.test(modl)){
			// retrieve it after
			queue.add( modl );

			// rewrite to use local copy from same external file dump
			const local = paf.relative(paf.dirname(p2.www), www);
			// for unversioned write a js file later (when resolved) that points from bare reference to the js file resolved
			if(verbose){
				console.warn(`found ^http> ${ first }"${ local }"; // in ${ url }`);
				console.warn(`queue added ${ modl }`);
			}

			return `${ first }"${ local }"`;
		}else if(/^\./.test(modl)){
		/*
		new URL('../directive.js?module', 'https://unpkg.com/lit-html@2.1.1/directives/async-append.js?module');
		=> https://unpkg.com/lit-html@2.1.1/directive.js?module
			*/
			const modlurl = new URL(modl, url2);
			if(!ext && wwwext){
			/* add extension based on best guess
			 https://unpkg.com/@supabase/storage-js@2.5.4/dist/module/lib/version?module
			 https://unpkg.com/@supabase/storage-js@2.5.4/dist/module/lib/version.js?module
			 * */
				modlurl.pathname += wwwext;
			}
			queue.add( modlurl.href );
			let local = modl.replace(/\?.*$/,'');
			if(verbose){
				console.warn(
`
found ^. > ${ first }"${ local }"; // in ${ url }
queue added ${ modlurl.href }
`				);
			}
			// leave as-is, sans get args '../any.js?args' => '../any.js'
			if(!ext){
			// assuming any module reference without an extension is a .js file
			// otherwise fix manually--beyond the scope of this script
				local += '.js';
			}

			return `${ first }"${ local }"`;
		}else if(modl.startsWith('/')){

			const _modl = modl.replace(/^\/npm\//,'/').replace(/\?.*$/,'').replace(/\/+esm$/,'');
			const _url2 = new URL(_modl, url);
			const { path, unversioned, versioned, name, wwwbasename, version, ext, wwwext, www, wwwversioned } = urlToPath( _url );
			const modlurl = new URL(modl, url2);
			if(!ext){
				let ending = '';
				const _esm_ = '/+esm';
				let { pathname } = modlurl;
				if(pathname.endsWith(_esm_)){
					ending += _esm_;
					pathname = pathname.substr(0, pathname.length - (_esm_.length))
				}
				if(pathname.endsWith('/')){
					pathname = pathname.substr(0, pathname.length - 1);
				}
				modlurl.pathname = `${ pathname }/${ wwwbasename }${ ending }`;
			}
			queue.add( modlurl.href );

			// rewrite to use local copy from same external file dump
			const local = paf.relative(paf.dirname(p2.www), www);
			const localversioned = paf.relative(paf.dirname(p2.www), wwwversioned);
			if(verbose){
				console.warn(
`
found ^/ in ${ url }
queue added ${ modlurl.href }
${ first }"${ local }";
${ first }"${ localversioned }";
`				);
				//console.warn(`---`,{url,modl,all,versioned,path,name,wwwbasename,ext,wwwext,www,wwwversioned, local, localversioned, p2:p2.www, p1:p1.www, url1, url2, _url2, _url});
			}
			
			return `${ first }"${ localversioned }"`;
		}else{
			if(verbose){
				console.warn(`found unknown module > ${ all } // in ${ url } `);
			}
			return all;
		}
	}); // output from .replace

	const exports = /\bexport\b/.test(output)

	let local, file, text;
	// allow redirects with compatible version
	if(p2.ext === '.js'){
		if(p1.unversioned !== p2.unversioned){
			if(!p1.ext.endsWith('.js')){
				local = paf.relative(paf.dirname(p1.unversioned), p2.versioned);
				if(!local .startsWith('.')){
					local = './' + local;
				}
				// bare-module scenario eg import 'foo'
				// write foo.js file exporting from redirected
				file = paf.resolve(relative, `${ p1.unversioned }.js`);
				text = `/*-${ oururl } redirected to ${ url }
		*/ ${ exports ? 'export * from':'import'} "${ local }";`
				if(verbose){
					console.log(`write (for "${ p1.versioned }")`, file, text);
				}
				writeFileSync(file, text);
			}else{
				throw new Error(`unexpected assumed bare url translation has .js extension ${ url } (via ${ oururl })`);
			};

			if(p2.ext.endsWith('.js')){
				file = paf.resolve(relative, `${ p2.versioned }`);
				if(verbose){
					console.log(`write (for "${ p2.versioned }")`, file, `${output.substring(0, 22)}...`);
				}
				writeFileSync(file, output);
			}else{
				console.warn(`unknown redirect missing .js extension `, {p1, p2, url, oururl});
				throw new Error(`unexpected bare url translation missing .js extension ${ url } (via ${ oururl })`);
			}
		}else{
		// always use most recent from any potential redirected compatible version
			if(p2.ext.endsWith('.js')){
				// no redirect, write file
				file = paf.resolve(relative, `${ p2.versioned }`);
				writeFileSync(file, output);

				if(p2.versioned !== p1.versioned){
				// in cases where redirecting to a newer compatible version, create an importable file for it
					file = paf.resolve(relative, `${ p1.versioned }`);
					local = paf.relative(paf.dirname(p1.versioned), p2.versioned);
					writeFileSync(file,
	`/*+${ oururl } versioned redirected to ${ url }
		*/ ${ exports ? 'export * from':'import'} "${ local }";`
					);
				};
				// also include unversioned reference for most recent version loaded
				// semver 1.2.3 -> [1,2,3] major.minor.point
				// solve problem with older unversioned bare overwriting more recent one (eg 2.1.0 overwriting 2.1.1 breaking updated versions) with each pass
				// note this could potentially resurface in scenarios where this script isn't aware of prior versions run separately
				// and it's also not the solutions intent to solve this problem beyond the current scope of run once with all of these run together at once
				const semver = p2.semver;
				const prev = unver[ p2.unversioned ];
				let isMostRecentVersion = (prev && versionDiff(prev, semver) > 0) || true;
				if(isMostRecentVersion){
				// unversioned overwrites any prior versions (each script run) pointing to most recent vesion loaded in that run
					unver[ p2.unversioned ] = semver;
					const unversioned = paf.resolve(relative, `${ p2.unversioned }`);
					local = paf.relative(paf.dirname(p2.unversioned), p2.versioned);
					if(!local.startsWith('.')){
						local = './' + local;
					}
					writeFileSync(unversioned,
	`/*3 ${ p2.versioned } */${ exports ? 'export * from':'import'} "${ local }";`
					);
					if(verbose){
						console.log(`no redirect write "${ p2.versioned }"`, file, `include unversioned "${ p2.unversioned }" at ${ local }`);
					}
				}
			}else{
				throw new Error(`url missing .js extension ${ url } (via ${ oururl })`);
			}
		}
	}else{
	// not .js; ie css, etc (text files only currently)
		if(p2.ext && output){
			writeFileSync(paf.resolve(config.wwwroot, relative, p2.versioned), output);
		}else{
			console.warn(new Error(`missing extension and not sure what to do with content "${ p2.versioned }"`));
		}
	}

	return Promise.resolve(output);
}

function writeFileSync(path, content){
	fs.ensureDirSync( paf.dirname(path) );
	Deno.writeTextFileSync(path, content);
}

/*
const foo = [[1,2,3],[3,4,5],[11,12,13], [11,0,0], [0,0,0]];
foo.sort(versionDiff);
console.log({foo}); =>  [0,0,0], [1,2,3], [3,4,5], [11,0,0], [11,12,13]


const foo = [versionDiff([0,0,1], [3,4,5]), versionDiff([7,0,1], [1,2,3]), versionDiff([1,2,3],[1,2,3])];
console.log({foo}); // [-3, 6, 0]

 * */
function versionDiff(a, b){
// a & b like [1,2,3] (derived from '1.2.3')
// 0 === same version
// > 0 a newer than b, b is older
// < 0 a older than b, b is newer
	let d = 0;
	if(!a || !b) console.warn({a,b});
	for(let i = 0;i<3;i++){
		d = a[i] - b[i];
		if(d !== 0){
			break;
		}
	}
	return d;
}

function vvversion(semver=''){
	return (semver.split('.')).map(n=>Number(n) || 0);
}
