import { readFileSync } from 'fs'
import path from 'path'
import { performance } from 'perf_hooks'
import { Lua } from '../dist/index.js'
import fengari from 'fengari'

const heapsort = readFileSync(path.resolve(import.meta.dirname, 'heapsort.lua'), 'utf-8')

function calculateStats(times) {
    const n = times.length
    const avg = times.reduce((sum, t) => sum + t, 0) / n
    const stdDev = Math.sqrt(times.reduce((sum, t) => sum + (t - avg) ** 2, 0) / n)
    return { avg, stdDev }
}

async function benchmark(name, iterations, warmup, fn) {
    console.log(`\nBenchmarking ${name}...`)

    for (let i = 0; i < warmup; i++) {
        await fn()
    }

    const times = []
    for (let i = 0; i < iterations; i++) {
        const start = performance.now()
        await fn()
        const end = performance.now()
        times.push(end - start)
    }

    const { avg, stdDev } = calculateStats(times)
    console.log(`${name}: ${iterations} iterations | avg: ${avg.toFixed(3)} ms | std dev: ${stdDev.toFixed(3)} ms`)
}

async function benchmarkFengari(iterations, warmup) {
    function runFengariIteration() {
        const state = fengari.lauxlib.luaL_newstate()
        fengari.lualib.luaL_openlibs(state)
        fengari.lauxlib.luaL_loadstring(state, fengari.to_luastring(heapsort))
        fengari.lua.lua_callk(state, 0, 1, 0, null)
        fengari.lua.lua_callk(state, 0, 0, 0, null)
    }
    await benchmark('Fengari', iterations, warmup, runFengariIteration)
}

async function benchmarkWasmoon(iterations, warmup) {
    const lua = await Lua.load()

    async function runWasmoonIteration() {
        const state = lua.createState()
        state.global.lua.luaL_loadstring(state.global.address, heapsort)
        state.global.lua.lua_callk(state.global.address, 0, 1, 0, null)
        state.global.lua.lua_callk(state.global.address, 0, 0, 0, null)
    }
    await benchmark('Wasmoon', iterations, warmup, runWasmoonIteration)
}

const iterations = 100
const warmup = 10

await benchmarkFengari(iterations, warmup)
await benchmarkWasmoon(iterations, warmup)
