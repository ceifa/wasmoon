import { Lua } from '../dist/index.js'
import fengari from 'fengari'
import { isMainModule, parseBenchOptions, readBenchAsset, runBenchmarks } from './utils.js'

const heapsort = readBenchAsset('heapsort.lua')

function runFengariIteration() {
    const state = fengari.lauxlib.luaL_newstate()
    try {
        fengari.lualib.luaL_openlibs(state)
        assertStatus(fengari.lauxlib.luaL_loadstring(state, fengari.to_luastring(heapsort)), 'Fengari load')
        assertStatus(fengari.lua.lua_pcallk(state, 0, 1, 0, 0, null), 'Fengari compile')
        assertStatus(fengari.lua.lua_pcallk(state, 0, 1, 0, 0, null), 'Fengari execute')
    } finally {
        fengari.lua.lua_close(state)
    }
}

function createWasmoonIteration(lua) {
    return function runWasmoonIteration() {
        const state = lua.createState()
        try {
            assertStatus(state.global.lua.luaL_loadstring(state.global.address, heapsort), 'Wasmoon load')
            assertStatus(state.global.lua.lua_pcallk(state.global.address, 0, 1, 0, 0, null), 'Wasmoon compile')
            assertStatus(state.global.lua.lua_pcallk(state.global.address, 0, 1, 0, 0, null), 'Wasmoon execute')
        } finally {
            state.global.close()
        }
    }
}

function assertStatus(status, label) {
    if (status !== 0) {
        throw new Error(`${label} failed with status ${status}`)
    }
}

export async function runComparisonBench(options = {}) {
    const lua = await Lua.load()
    return runBenchmarks({
        title: 'Comparison benchmarks',
        benches: [
            { name: 'Fengari heapsort', run: runFengariIteration },
            { name: 'Wasmoon heapsort', run: createWasmoonIteration(lua) },
        ],
        options,
    })
}

if (isMainModule(import.meta.url)) {
    await runComparisonBench(parseBenchOptions())
}
