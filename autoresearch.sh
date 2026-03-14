#!/bin/bash
set -euo pipefail

build_start=$(python3 - <<'PY'
import time
print(time.time())
PY
)

npm run build:wasm >/dev/null
npm run build >/dev/null

build_end=$(python3 - <<'PY'
import time
print(time.time())
PY
)

wasm_build_seconds=$(python3 - <<PY
print(round(${build_end} - ${build_start}, 6))
PY
)

glue_wasm_kb=$(python3 - <<'PY'
from pathlib import Path
print(round(Path('build/glue.wasm').stat().st_size / 1024, 3))
PY
)

node --input-type=module <<EOF
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const heapsort = readFileSync(path.join(root, 'bench', 'heapsort.lua'), 'utf8')
const distIndex = pathToFileURL(path.join(root, 'dist', 'index.js')).href
const { Lua } = await import(distIndex)

function stats(times) {
  const avg = times.reduce((sum, t) => sum + t, 0) / times.length
  const variance = times.reduce((sum, t) => sum + (t - avg) ** 2, 0) / times.length
  return { avg, stddev: Math.sqrt(variance) }
}

const iterations = 60
const warmup = 8
const lua = await Lua.load()

async function runIteration() {
  const state = lua.createState()
  state.global.lua.luaL_loadstring(state.global.address, heapsort)
  state.global.lua.lua_callk(state.global.address, 0, 1, 0, null)
  state.global.lua.lua_callk(state.global.address, 0, 0, 0, null)
  state.global.close()
}

for (let i = 0; i < warmup; i++) {
  await runIteration()
}

const times = []
for (let i = 0; i < iterations; i++) {
  const start = performance.now()
  await runIteration()
  times.push(performance.now() - start)
}

const { avg, stddev } = stats(times)
console.log(`METRIC wasmoon_heapsort_avg_ms=${avg.toFixed(6)}`)
console.log(`METRIC wasmoon_heapsort_stddev_ms=${stddev.toFixed(6)}`)
console.log(`METRIC wasm_build_seconds=${Number(${wasm_build_seconds}).toFixed(6)}`)
console.log(`METRIC glue_wasm_kb=${Number(${glue_wasm_kb}).toFixed(3)}`)
console.log(`METRIC iterations=${iterations}`)
console.log(`METRIC warmup=${warmup}`)
EOF
