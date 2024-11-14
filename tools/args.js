const symbols = {
	help: Symbol.for('help'),
	config: Symbol.for('config')
};

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
	args.reduce(args_reducer, config);
	if(config[symbols.help] && helpText){
		if(typeof helpText === 'function'){
			helpText(config);
		}else{
			console.log(helpText + `
${ JSON.stringify(config, false, '\t') }
`			);
			Deno.exit(0);
		}
	}else if(config[symbols.config]){
		console.log(`
${ JSON.stringify(config, false, '\t') }
`		);
	}

	return config;
}
export { args_to_config as args, args_reducer, args_to_config as default };
