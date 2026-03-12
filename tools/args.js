
/* 
	- macos PATH_MAX is 1024, which is absurdly large for an option
	- options like that should not exist--for any general case
	- any need for large values also require a parser and validator to go with it. normal args are NOT that large
	- config file loading, large properties, parsing, validation beyond what's here, etc are OUT OF SCOPE for this
*/
const MAX_VAL_LENGTH = 256;

const symbols = Object.defineProperties({}, {
	help: {value: Symbol.for('help'), enumerable: true},
	config: {value: Symbol.for('config'), enumerable: true},
	positionals: {value: Symbol.for('positionals'), enumerable: true}
});

function args_reducer(config, arg, i){
	// allow -name=value or -name:value, with any number of leading '-' or '--' or '------'
	const parts = arg.match(/^-+([a-z][a-z0-9_]*)(?:[=:]?(.+))?/i);
	if(parts){
		const [all, name, value = ''] = parts;
		// -help -h -config -c
		if(/^(?:help|h|config|c)$/.test(name) && !config.hasOwnProperty(name)){
			let key = name;
			if(name === 'h') key = 'help';
			else if(name === 'c') key = 'config';
			config[symbols[key]] = true;

			return config;
		}
		if((name === 'help' || name === 'h') && !config.hasOwnProperty(name)){
			config[symbols.help] = true;
			return config;
		}
		// can only set predefined properties
		if(!config || !config.hasOwnProperty(name) || config[name] === undefined){
			return config;
		}

		let val = value.trim();
		// NOTE: guard against oversized values (injection, accidents, hostile input)
		if(val.length > MAX_VAL_LENGTH){
			console.warn(`skip oversized value for option "${name}" (${val.length} chars, max ${MAX_VAL_LENGTH})`);
			return config;
		}
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
	}

	return config;

}
/*
 * NOTE 
 * config must have existing properties, they cannot be undefined
 * if input type is mismatched to existing, skips with warning
 * lead each with any number of '-' like ----option and -option
 * values follow with ':' or '=' and value, like -option:1 and --option=2
 * values must start with ascii letter then any ascii+number or _ eg a1b=
  
 * with boolean existing property, 0 and false become false
   -bool='any' is coerced 
   -bool is assumed true (eg -bool becomes bool:true)

 * provide optional help text argument and it will print and exit on -h or -help
   use a function instead for more control, no exit

 * -config -c show the options as used
  
 * example usage:
  
deno run path/to/args_to_config.js -a=123 -b=c

import { args } from './path/to/args.js';
const config = {a:0, b:b}

args(Deno.args, config);

console.log(config);
// -> {a:123, b:"c"}


 * example with help option, eg deno run script.js -a=123 -help
 
   args(Deno.args, config, `help text...`)
   // exits with console output:
 		help text...
		{"a": 123}
 * */

function args_to_config(args=Deno.args, config, helpText=``){
	if(!args || !args.reduce || !config) return config;
	// NOTE: '--' sentinel — everything after is positional, not parsed as flags
	const sentinelIdx = args.indexOf('--');
	const flagArgs = sentinelIdx === -1 ? args : args.slice(0, sentinelIdx);
	if(sentinelIdx !== -1){
		config[symbols.positionals] = args.slice(sentinelIdx + 1);
	}
	flagArgs.reduce(args_reducer, config);

	if(config[symbols.help] && helpText){
		if(typeof helpText === 'function'){
			helpText(config);
		}else{
			console.log(helpText + `
${ JSON.stringify(config, false, '\t') }
`			);
			// NOTE: string help path exits; use function form for custom control without exit
			Deno.exit(0);
		}
	}else if(config[symbols.config]){
		console.log(`
${ JSON.stringify(config, false, '\t') }
`		);
	}

	return config;
}
export { symbols, args_to_config as args, args_reducer, args_to_config as default };
