#!/bin/bash
set -euo pipefail
npm test >/tmp/wasmoon-autoresearch-tests.log 2>&1 || { tail -50 /tmp/wasmoon-autoresearch-tests.log; exit 1; }
if ! grep -q '@types/emscripten' package.json; then
    test -f dist/emscripten.d.ts || { echo 'missing dist/emscripten.d.ts for published typings'; exit 1; }
fi
