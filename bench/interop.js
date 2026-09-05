import { LuaRuntime } from '../dist/index.js'
import assert from 'node:assert/strict'
import { isMainModule, parseBenchOptions, runBenchmarks } from './utils.js'

// Every bench here keeps its Lua work trivial so the timings are dominated by the JS side of the
// boundary: pushValue/getValue, the type extension lookup and the ccall wrappers around the C API.
const CALL_COUNT = 20000
const TABLE_SIZE = 2000

function withState(lua, options, body) {
    return () => {
        const state = lua.createState(options)
        try {
            return body(state)
        } finally {
            state.close()
        }
    }
}

function createGlobalRoundTripBenchmark(lua) {
    return withState(lua, {}, (state) => {
        for (let i = 0; i < CALL_COUNT; i++) {
            state.set('value', i)
            if (state.get('value') !== i) {
                throw new Error('global round trip returned the wrong value')
            }
        }
    })
}

// Both directions switch between an inline copy and the built in codecs by length, so the sizes
// on either side of those thresholds are measured rather than one arbitrary string.
function createStringRoundTripBenchmark(lua, length) {
    const value = 'abcdefghij'.repeat(Math.ceil(length / 10)).slice(0, length)
    return withState(lua, {}, (state) => {
        for (let i = 0; i < CALL_COUNT; i++) {
            state.set('value', value)
            if (state.get('value') !== value) {
                throw new Error('string round trip returned the wrong value')
            }
        }
    })
}

function createCallLuaFromJsBenchmark(lua) {
    return withState(lua, {}, (state) => {
        state.doStringSync('function add(a, b) return a + b end')
        const add = state.get('add')
        let sum = 0
        for (let i = 0; i < CALL_COUNT; i++) {
            sum += add(i, 1)
        }
        assert.equal(sum, (CALL_COUNT * (CALL_COUNT - 1)) / 2 + CALL_COUNT)
    })
}

function createPushNullBenchmark(lua) {
    return withState(lua, { inject: true }, (state) => {
        for (let i = 0; i < CALL_COUNT; i++) {
            state.pushValue(null)
            state.pop()
        }
        state.pushValue(null)
        assert.equal(state.getValue(-1), null)
        state.pop()
        assert.equal(state.getTop(), 0)
    })
}

function createCallJsFromLuaBenchmark(lua) {
    return withState(lua, {}, (state) => {
        state.set('add', (a, b) => a + b)
        const total = state.doStringSync(`
            local sum = 0
            for i = 1, ${CALL_COUNT} do sum = sum + add(i, 1) end
            return sum
        `)
        assert.equal(total, (CALL_COUNT * (CALL_COUNT + 1)) / 2 + CALL_COUNT)
    })
}

function createReadTableBenchmark(lua) {
    return withState(lua, { objects: 'copy' }, (state) => {
        state.doStringSync(`
            data = {}
            for i = 1, ${TABLE_SIZE} do data[i] = { id = i, name = "item" .. i, active = i % 2 == 0 } end
        `)
        const data = state.get('data')
        assert.equal(data.length, TABLE_SIZE)
    })
}

function createPushTableBenchmark(lua) {
    const data = Array.from({ length: TABLE_SIZE }, (_, index) => ({
        id: index,
        name: `item${index}`,
        active: index % 2 === 0,
    }))
    return withState(lua, { objects: 'copy' }, (state) => {
        state.set('data', data)
    })
}

function createProxyAccessBenchmark(lua) {
    const data = { counter: 0, nested: { value: 1 } }
    return withState(lua, {}, (state) => {
        state.set('data', data)
        const total = state.doStringSync(`
            local sum = 0
            for i = 1, ${CALL_COUNT} do sum = sum + data.nested.value end
            return sum
        `)
        assert.equal(total, CALL_COUNT)
    })
}

function createDoStringBenchmark(lua) {
    return withState(lua, {}, (state) => {
        for (let i = 0; i < 200; i++) {
            state.doStringSync('return 1 + 1')
        }
    })
}

export async function runInteropBench(options = {}) {
    const lua = await LuaRuntime.load()

    return runBenchmarks({
        title: 'Interop benchmarks',
        benches: [
            { name: 'Global round trip (number)', run: createGlobalRoundTripBenchmark(lua) },
            { name: 'Global round trip (string, 8)', run: createStringRoundTripBenchmark(lua, 8) },
            { name: 'Global round trip (string, 24)', run: createStringRoundTripBenchmark(lua, 24) },
            { name: 'Global round trip (string, 200)', run: createStringRoundTripBenchmark(lua, 200) },
            { name: 'Call Lua from JS', run: createCallLuaFromJsBenchmark(lua) },
            { name: 'Call JS from Lua', run: createCallJsFromLuaBenchmark(lua) },
            { name: 'Read table into JS', run: createReadTableBenchmark(lua) },
            { name: 'Push table into Lua', run: createPushTableBenchmark(lua) },
            { name: 'Push null into Lua', run: createPushNullBenchmark(lua) },
            { name: 'Proxy field access from Lua', run: createProxyAccessBenchmark(lua) },
            { name: 'doStringSync', run: createDoStringBenchmark(lua) },
        ],
        options,
    })
}

if (isMainModule(import.meta.url)) {
    await runInteropBench(parseBenchOptions())
}
