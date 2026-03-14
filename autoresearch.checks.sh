#!/bin/bash
set -euo pipefail
npm test >/tmp/wasmoon-autoresearch-tests.log 2>&1 || { tail -50 /tmp/wasmoon-autoresearch-tests.log; exit 1; }
if ! grep -q '@types/emscripten' package.json; then
    test -f dist/emscripten.d.ts || { echo 'missing dist/emscripten.d.ts for published typings'; exit 1; }
fi
pkgdir=$(mktemp -d)
npm pack >/dev/null
trap 'rm -rf "$pkgdir" wasmoon-1.16.0.tgz' EXIT
tar -xzf wasmoon-1.16.0.tgz -C "$pkgdir"
printf '{"compilerOptions":{"module":"es2022","moduleResolution":"bundler","target":"es2022","strict":true,"skipLibCheck":true}}' > "$pkgdir/package/tsconfig.json"
printf 'import type LuaModule from "./dist/module.js"\ndeclare let m: LuaModule\nvoid m\n' > "$pkgdir/package/smoke.ts"
./node_modules/.bin/tsc --noEmit -p "$pkgdir/package/tsconfig.json" >/tmp/wasmoon-pack-tsc.log 2>&1 || { tail -50 /tmp/wasmoon-pack-tsc.log; exit 1; }
