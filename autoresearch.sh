#!/bin/bash
set -euo pipefail

npm run build >/tmp/wasmoon-autoresearch-build.log 2>&1

node --input-type=module <<'EOF'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { Lua } from './dist/index.js'

const buildLog = readFileSync('/tmp/wasmoon-autoresearch-build.log', 'utf8')
const buildMsMatch = buildLog.match(/Done in ([0-9.]+)(ms|s)/)
const buildMs = buildMsMatch
    ? Number(buildMsMatch[1]) * (buildMsMatch[2] === 's' ? 1000 : 1)
    : 0

const pack = JSON.parse(execFileSync('npm', ['pack', '--json', '--dry-run'], { encoding: 'utf8' }))[0]
const heapsort = readFileSync(path.resolve('bench/heapsort.lua'), 'utf8')
const lua = await Lua.load()

for (let i = 0; i < 3; i++) {
    const state = lua.createState()
    state.global.lua.luaL_loadstring(state.global.address, heapsort)
    state.global.lua.lua_pcallk(state.global.address, 0, 1, 0, 0, null)
    state.global.lua.lua_pcallk(state.global.address, 0, 0, 0, 0, null)
}

const iterations = 10
const times = []
for (let i = 0; i < iterations; i++) {
    const state = lua.createState()
    const start = performance.now()
    state.global.lua.luaL_loadstring(state.global.address, heapsort)
    state.global.lua.lua_pcallk(state.global.address, 0, 1, 0, 0, null)
    state.global.lua.lua_pcallk(state.global.address, 0, 0, 0, 0, null)
    times.push(performance.now() - start)
}
const heapsortMs = times.reduce((sum, time) => sum + time, 0) / times.length

const sizeOf = (file) => pack.files.find((entry) => entry.path === file)?.size ?? 0
const kb = (bytes) => Number((bytes / 1024).toFixed(3))

console.log(`METRIC tarball_kb=${kb(pack.size)}`)
console.log(`METRIC unpacked_kb=${kb(pack.unpackedSize)}`)
console.log(`METRIC index_js_kb=${kb(sizeOf('dist/index.js'))}`)
console.log(`METRIC glue_wasm_kb=${kb(sizeOf('dist/glue.wasm'))}`)
console.log(`METRIC heapsort_ms=${Number(heapsortMs.toFixed(3))}`)
console.log(`METRIC build_ms=${Number(buildMs.toFixed(3))}`)
EOF
