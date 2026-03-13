import { assertEquals, assert, assertExists } from "https://jsr.io/@std/assert/1.0.13/mod.ts";
import { args, args_reducer, symbols } from "./args.js";
/*

deno test ./args.test.js

 * */

// ─── symbols ────────────────────────────────────────────────────────────────

Deno.test('symbols: exports help, config, positionals as Symbol.for keys', () => {
	assertEquals(symbols.help,       Symbol.for('help'));
	assertEquals(symbols.config,     Symbol.for('config'));
	assertEquals(symbols.positionals,Symbol.for('positionals'));
});

// ─── args_reducer ────────────────────────────────────────────────────────────

Deno.test('args_reducer: sets string value on predefined string property', () => {
	const config = { name: '' };
	args_reducer(config, '-name=hello');
	assertEquals(config.name, 'hello');
});

Deno.test('args_reducer: colon separator works the same as equals', () => {
	const config = { name: '' };
	args_reducer(config, '-name:world');
	assertEquals(config.name, 'world');
});

Deno.test('args_reducer: double-dash prefix works', () => {
	const config = { name: '' };
	args_reducer(config, '--name=deno');
	assertEquals(config.name, 'deno');
});

Deno.test('args_reducer: many leading dashes work', () => {
	const config = { name: '' };
	args_reducer(config, '------name=many');
	assertEquals(config.name, 'many');
});

Deno.test('args_reducer: parses number type', () => {
	const config = { port: 0 };
	args_reducer(config, '-port=8080');
	assertEquals(config.port, 8080);
});

Deno.test('args_reducer: skips invalid number and warns', () => {
	const config = { port: 3000 };
	args_reducer(config, '-port=notanumber');
	assertEquals(config.port, 3000);
});

Deno.test('args_reducer: boolean flag with no value becomes true', () => {
	const config = { verbose: false };
	args_reducer(config, '-verbose');
	assertEquals(config.verbose, true);
});

Deno.test('args_reducer: boolean flag explicit true string', () => {
	const config = { verbose: false };
	args_reducer(config, '-verbose=true');
	assertEquals(config.verbose, true);
});

Deno.test('args_reducer: boolean flag false via "false" string', () => {
	const config = { verbose: true };
	args_reducer(config, '-verbose=false');
	assertEquals(config.verbose, false);
});

Deno.test('args_reducer: boolean flag false via "0"', () => {
	const config = { verbose: true };
	args_reducer(config, '-verbose=0');
	assertEquals(config.verbose, false);
});

Deno.test('args_reducer: ignores unknown property not in config', () => {
	const config = { known: '' };
	args_reducer(config, '-unknown=val');
	assert(!Object.prototype.hasOwnProperty.call(config, 'unknown'), 'unknown key must not be added');
});

Deno.test('args_reducer: skips oversized value', () => {
	const config = { name: 'original' };
	const big = 'x'.repeat(257);
	args_reducer(config, `-name=${big}`);
	assertEquals(config.name, 'original');
});

Deno.test('args_reducer: value exactly at MAX_VAL_LENGTH (256) is accepted', () => {
	const config = { name: '' };
	const edge = 'x'.repeat(256);
	args_reducer(config, `-name=${edge}`);
	assertEquals(config.name, edge);
});

Deno.test('args_reducer: -help sets symbols.help', () => {
	const config = {};
	args_reducer(config, '-help');
	assertEquals(config[symbols.help], true);
});

Deno.test('args_reducer: -h sets symbols.help', () => {
	const config = {};
	args_reducer(config, '-h');
	assertEquals(config[symbols.help], true);
});

Deno.test('args_reducer: -config sets symbols.config', () => {
	const config = {};
	args_reducer(config, '-config');
	assertEquals(config[symbols.config], true);
});

Deno.test('args_reducer: -c sets symbols.config', () => {
	const config = {};
	args_reducer(config, '-c');
	assertEquals(config[symbols.config], true);
});

Deno.test('args_reducer: non-flag argument is ignored gracefully', () => {
	const config = { name: 'default' };
	args_reducer(config, 'positional-looking-value');
	assertEquals(config.name, 'default');
});

// ─── args (args_to_config) ───────────────────────────────────────────────────

Deno.test('args: returns config unchanged when args is empty', () => {
	const config = { port: 3000, host: 'localhost' };
	const result = args([], config);
	assertEquals(result.port, 3000);
	assertEquals(result.host, 'localhost');
});

Deno.test('args: returns config when args is null/undefined', () => {
	const config = { port: 3000 };
	assertEquals(args(null, config), config);
	assertEquals(args(undefined, config), config);
});

Deno.test('args: returns config when config is null/undefined', () => {
	assertEquals(args(['-port=1'], null), null);
	assertEquals(args(['-port=1'], undefined), undefined);
});

Deno.test('args: processes multiple flags in one call', () => {
	const config = { port: 0, host: '', verbose: false };
	args(['-port=9000', '-host=example.com', '-verbose'], config);
	assertEquals(config.port, 9000);
	assertEquals(config.host, 'example.com');
	assertEquals(config.verbose, true);
});

Deno.test('args: -- sentinel splits flags from positionals', () => {
	const config = { port: 0 };
	args(['-port=1234', '--', 'file1.txt', 'file2.txt'], config);
	assertEquals(config.port, 1234);
	assertExists(config[symbols.positionals]);
	assertEquals(config[symbols.positionals], ['file1.txt', 'file2.txt']);
});

Deno.test('args: everything after -- is positional, none parsed as flags', () => {
	const config = { port: 0 };
	args(['--', '-port=9999'], config);
	assertEquals(config.port, 0);
	assertEquals(config[symbols.positionals], ['-port=9999']);
});

Deno.test('args: no -- means no positionals key set', () => {
	const config = { port: 0 };
	args(['-port=1'], config);
	assert(!Object.prototype.hasOwnProperty.call(config, symbols.positionals), 'positionals symbol must not exist without --');
});

Deno.test('args: function-form helpText is called without exit', () => {
	const config = { port: 0 };
	let called = false;
	args(['-h'], config, (cfg) => { called = true; });
	assert(called, 'help function must be invoked');
});

Deno.test('args: helpText function receives config', () => {
	const config = { port: 1234 };
	let received = null;
	args(['-help'], config, (cfg) => { received = cfg; });
	assertEquals(received, config);
});

Deno.test('args: no helpText means -help flag is set but nothing printed/exited', () => {
	const config = {};
	args(['-h'], config);
	assertEquals(config[symbols.help], true);
});
