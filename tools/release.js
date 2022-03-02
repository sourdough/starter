/*
deno run --allow-read=./ --allow-write=./ tools/release.js
 * */
const options = {
	version: '',
	save: false
};

const versionPattern = /(?:[0-9]+\.){2}[0-9_a-zA-Z.-]*$/;

Deno.args.reduce(function _options_(options, arg, i){
	const parts = arg.match(/^-+([a-z][a-z0-9]+)(?:[=:]?(.+))?/i);
	if(parts){
		const [all, name, value = ''] = parts;
		if(options[name] !== undefined){
			switch(typeof options[name]){
			case 'string':
				options[name] = value;
			break;
			case 'boolean':
				options[name] = value === 'true';
			break;
			};
		}
	}
	return options
}, options);

const { version, save } = options;

if(versionPattern.test(version)){
	console.log(`
updating version to "${ version }"...
${ options.save ? 'and ':'NOT ' }saving to files...
`);
}else{
	console.warn(`
	version "${ version }" is invalid, 
	include a version option like -version=2.4.6-pre.7

	deno run --allow-read=./ --allow-write=./ tools/release.js --version=2.4.6

	add option --save=true to write the change to the file

	`);

}

[
/*
	['./package.json', 
	/\"version\":\s*\"([^\"]+)\"/,
	function(){
		return `"version": "${ version }"`;
	}
	],
	['./package-lock.json',
	/(\"name\":\s+\"ingredient\",[\n\r\t\s]+\"version\":\s+)\"[^\"]+\"/g,
	function(all, first){
		return `${ first }"${ version }"`;
	}
	],
*/
	['./www/worker.js',
	/\sversion = (['"`])v(?:[0-9]+\.){2}[0-9_a-zA-Z.-]*['"`]/,
	function(all, quote){
		return ` version = ${quote}v${ version }${quote}`;
	}
	],
].forEach(function updateVersion([file, pattern, replacement], i){
	const text = Deno.readTextFileSync(file);
	const found = text.match(pattern) ?? [];
	const update = text.replace(pattern, replacement);
	const replaced = update.match(pattern) ?? [];
	console.log(`
${file}
-> "${ found[0] }"
<- "${ replaced[0] }"`);

	if( found[0] === replaced[0] ){
		console.log(`~ unchanged`);
	}else if( replaced[0] ){
		if(save){
			Deno.writeTextFileSync(file, update);
			console.log(`+ saved`);
		}else{
			console.log(`+ changed`);
		}
	}else{
		console.log(`- incorrect?`);
	}
});

console.log(`
done 🍞


typical release process includes:

git status
git diff
git add .
git commit -v -m "release version ${ version }" -e
git tag -a v${ version } -m "v${ version }"
git push --follow-tags

`);
