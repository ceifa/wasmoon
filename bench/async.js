import { LuaRuntime } from '../dist/index.js'
import assert from 'node:assert/strict'
import { isMainModule, parseBenchOptions, runBenchmarks } from './utils.js'

// The cost of the asynchronous paths on their own: every promise here is settled already, so what
// is timed is the suspend and resume around it rather than whatever it would be waiting for.
const AWAIT_COUNT = 20000
const RUN_COUNT = 1000
const PARKED_RUNS = 1000

function withState(lua, body) {
    return async () => {
        const state = lua.createState({ inject: true })
        try {
            return await body(state)
        } finally {
            state.close()
        }
    }
}

function createSettledAwaitBenchmark(lua) {
    return withState(lua, async (state) => {
        state.set('ready', Promise.resolve(1))
        const total = await state.doString(`
            local sum = 0
            for i = 1, ${AWAIT_COUNT} do sum = sum + ready:await() end
            return sum
        `)
        assert.equal(total, AWAIT_COUNT)
    })
}

function createDoStringBenchmark(lua) {
    return withState(lua, async (state) => {
        for (let i = 0; i < RUN_COUNT; i++) {
            assert.equal(await state.doString('return 1'), 1)
        }
    })
}

function createStateAsyncBenchmark(lua) {
    return withState(lua, async (state) => {
        state.doStringSync('function add(a, b) return a + b end')
        const add = state.async(state.get('add'))
        for (let i = 0; i < RUN_COUNT; i++) {
            assert.equal(await add(i, 1), i + 1)
        }
    })
}

function createLuaAsyncBenchmark(lua) {
    return withState(lua, async (state) => {
        const total = await state.doString(`
            local add = async(function(a, b) return a + b end)
            local sum = 0
            for i = 1, ${RUN_COUNT} do sum = sum + add(i, 1):await() end
            return sum
        `)
        assert.equal(total, (RUN_COUNT * (RUN_COUNT + 1)) / 2 + RUN_COUNT)
    })
}

// What a run costs while it waits, which no timing shows. Needs `node --expose-gc`.
async function printParkedRunMemory(lua) {
    if (typeof globalThis.gc !== 'function') {
        console.log('\nMemory of a parked run: skipped, run node with --expose-gc to measure it')
        return
    }

    const state = lua.createState({ memory: { trace: true } })
    try {
        const gate = Promise.withResolvers()
        state.set('gate', gate.promise)
        state.gc.collect()
        globalThis.gc()
        const jsBefore = process.memoryUsage().heapUsed
        const luaBefore = state.memory.used

        const runs = Array.from({ length: PARKED_RUNS }, () => state.doString('gate:await() return 1'))
        // The runs park as their await hooks get to run, which takes a turn of the event loop.
        await new Promise((resolve) => setTimeout(resolve, 20))
        globalThis.gc()
        const js = (process.memoryUsage().heapUsed - jsBefore) / PARKED_RUNS
        const lua = (state.memory.used - luaBefore) / PARKED_RUNS

        gate.resolve()
        await Promise.all(runs)
        console.log(`\nMemory of a parked run: ${js.toFixed(0)} bytes of JS heap, ${lua.toFixed(0)} bytes of Lua heap`)
    } finally {
        state.close()
    }
}

export async function runAsyncBench(options = {}) {
    const lua = await LuaRuntime.load()

    const results = await runBenchmarks({
        title: 'Async benchmarks',
        benches: [
            { name: 'Await a settled promise', run: createSettledAwaitBenchmark(lua) },
            { name: 'doString', run: createDoStringBenchmark(lua) },
            { name: 'Call Lua from JS with state.async', run: createStateAsyncBenchmark(lua) },
            { name: 'Call a Lua async function', run: createLuaAsyncBenchmark(lua) },
        ],
        options,
    })
    await printParkedRunMemory(lua)
    return results
}

if (isMainModule(import.meta.url)) {
    await runAsyncBench(parseBenchOptions())
}
