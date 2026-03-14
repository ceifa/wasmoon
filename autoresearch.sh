#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"

START_NS=$(node -e 'process.stdout.write(String(process.hrtime.bigint()))')

node --check utils/build-wasm.js >/dev/null

npm run build:wasm >/dev/null
npm run build >/dev/null

END_BUILD_NS=$(node -e 'process.stdout.write(String(process.hrtime.bigint()))')

START_NS="$START_NS" END_BUILD_NS="$END_BUILD_NS" node <<'NODE'
import { statSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'
import path from 'node:path'
import { Lua } from './dist/index.js'

const root = process.cwd()
const heapsort = readFileSync(path.join(root, 'bench', 'heapsort.lua'), 'utf8')
const startNs = BigInt(process.env.START_NS)
const endBuildNs = BigInt(process.env.END_BUILD_NS)

async function averageMs(iterations, fn) {
    const samples = []
    for (let i = 0; i < iterations; i++) {
        const t0 = performance.now()
        await fn()
        samples.push(performance.now() - t0)
    }
    return samples.reduce((a, b) => a + b, 0) / samples.length
}

const wasmBuffer = readFileSync(path.join(root, 'build', 'glue.wasm'))
const wasmBytes = statSync(path.join(root, 'build', 'glue.wasm')).size
const wasmGzipBytes = gzipSync(wasmBuffer).length
const buildMs = Number(endBuildNs - startNs) / 1e6

const startupMs = await averageMs(5, async () => {
    await Lua.load()
})

const lua = await Lua.load()
const createStateMs = await averageMs(20, async () => {
    const state = lua.createState()
    state.global.close()
})

const heapsortMs = await averageMs(10, async () => {
    const state = lua.createState()
    state.global.lua.luaL_loadstring(state.global.address, heapsort)
    state.global.lua.lua_pcallk(state.global.address, 0, 1, 0, 0, null)
    state.global.lua.lua_pcallk(state.global.address, 0, 0, 0, 0, null)
    state.global.close()
})

console.log(`METRIC wasm_bytes=${wasmBytes}`)
console.log(`METRIC wasm_gzip_bytes=${wasmGzipBytes}`)
console.log(`METRIC startup_ms=${startupMs.toFixed(3)}`)
console.log(`METRIC create_state_ms=${createStateMs.toFixed(3)}`)
console.log(`METRIC heapsort_ms=${heapsortMs.toFixed(3)}`)
console.log(`METRIC build_ms=${buildMs.toFixed(3)}`)
NODE
