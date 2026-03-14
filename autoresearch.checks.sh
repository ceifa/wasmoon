#!/bin/bash
set -euo pipefail
npm test >/tmp/wasmoon-autoresearch-tests.log 2>&1 || { tail -50 /tmp/wasmoon-autoresearch-tests.log; exit 1; }
