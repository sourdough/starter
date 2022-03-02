echo 'toolkit aliases'

if command_exists deno ; then
	echo '🦕 deno'
fi

export PORT=8000

# if corporate firewalls interfere with using deno
# add option `--unsafely-ignore-certificate-errors` to deno commands
# https://github.com/denoland/deno/issues/1371

# adjust aliases to suit any project
alias sourhttp="deno run --allow-read=./ --allow-net=0.0.0.0:$PORT ./tools/http.js --port=$PORT --index=dev.html"
alias sourhttprelease="PORT=8000 deno run --allow-read=./ --allow-net=0.0.0.0:$PORT ./tools/http.js --port=$PORT"
alias sourtest="deno test --fail-fast ./www/"
alias souruitest="echo 'run http then uitest' && deno test -A --unstable ./www/uitest.runner.js -- --verbose"
alias sourimportexternals="deno run --allow-env --allow-read=./ --allow-write=./www/wildtype --allow-net='unpkg.com' ./tools/external.importer.js -file='./tools/external.dependencies.js' -dump=./wwww/wildtype"
alias sourlint='deno lint --config tools/deno.json'
alias sourrelease='deno run --allow-read=./ --allow-write=./ tools/release.js'
