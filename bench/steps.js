import { LuaRuntime } from '../dist/index.js'
import assert from 'node:assert/strict'
import { isMainModule, parseBenchOptions, readBenchAsset, runBenchmarks } from './utils.js'

const heapsort = readBenchAsset('heapsort.lua')
const luaObjectFixture = `
    local obj1 = {
        hello = 'world',
    }
    obj1.self = obj1
    local obj2 = {
        5,
        hello = 'everybody',
        array = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
        fn = function()
            return 'hello'
        end,
    }
    obj2.self = obj2
    obj = { obj1, obj2 }
`

function createComplexObjects() {
    const obj1 = {
        hello: 'world',
    }
    obj1.self = obj1

    const obj2 = {
        hello: 'everybody',
        array: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        fn: () => 'hello',
    }
    obj2.self = obj2

    return { obj1, obj2 }
}

function createStateBenchmark(lua, stateOptions = {}) {
    return function runCreateState() {
        const state = lua.createState(stateOptions)
        state.close()
    }
}

function createRawHeapsortBenchmark(lua) {
    return function runRawHeapsort() {
        const state = lua.createState()
        try {
            assertStatus(state.lua.luaL_loadstring(state.address, heapsort), 'Load raw heapsort')
            assertStatus(state.lua.lua_pcallk(state.address, 0, 1, 0, 0, null), 'Compile raw heapsort')
            assertStatus(state.lua.lua_pcallk(state.address, 0, 1, 0, 0, null), 'Execute raw heapsort')
        } finally {
            state.close()
        }
    }
}

function createInteropHeapsortBenchmark(lua) {
    return async function runInteropHeapsort() {
        const state = lua.createState()
        try {
            const executeHeapsort = await state.doString(heapsort)
            assert.equal(executeHeapsort(), 10)
        } finally {
            state.close()
        }
    }
}

function createInsertObjectsBenchmark(lua, stateOptions = {}) {
    return function runInsertObjects() {
        const state = lua.createState(stateOptions)
        try {
            state.set('obj', createComplexObjects())
        } finally {
            state.close()
        }
    }
}

function createGetObjectsBenchmark(lua) {
    return async function runGetObjects() {
        const state = lua.createState()
        try {
            await state.doString(luaObjectFixture)
            state.get('obj')
        } finally {
            state.close()
        }
    }
}

function assertStatus(status, label) {
    if (status !== 0) {
        throw new Error(`${label} failed with status ${status}`)
    }
}

export async function runStepBench(options = {}) {
    const lua = await LuaRuntime.load()

    return runBenchmarks({
        title: 'Operation benchmarks',
        benches: [
            { name: 'Create factory', run: () => LuaRuntime.load() },
            { name: 'Create state', run: createStateBenchmark(lua) },
            {
                name: 'Create state without superpowers',
                run: createStateBenchmark(lua, {
                    objects: 'copy',
                    inject: false,
                    libs: false,
                }),
            },
            { name: 'Run raw heapsort', run: createRawHeapsortBenchmark(lua) },
            { name: 'Run interoped heapsort', run: createInteropHeapsortBenchmark(lua) },
            { name: 'Insert complex objects', run: createInsertObjectsBenchmark(lua) },
            {
                name: 'Insert complex objects without proxy',
                run: createInsertObjectsBenchmark(lua, {
                    objects: 'copy',
                }),
            },
            { name: 'Get complex objects', run: createGetObjectsBenchmark(lua) },
        ],
        options,
    })
}

if (isMainModule(import.meta.url)) {
    await runStepBench(parseBenchOptions())
}
