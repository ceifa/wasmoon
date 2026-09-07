// node --expose-gc bench/async.js [path/to/index.js]
// An alternate bundle makes before/after comparisons use exactly the same workloads.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { LuaRuntime } = await import(pathToFileURL(resolve(process.argv[2] ?? 'dist/index.js')).href)
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]

for (const engine of ['yield', 'jspi']) {
    const runtime = await LuaRuntime.load({ async: engine })
    const state = runtime.createState({ inject: true, memory: { trace: true } })
    state.set('ready', Promise.resolve(1))
    state.set('add', (a, b) => a + b)
    state.doStringSync('function addLua(a, b) return a + b end')
    const addLua = state.get('addLua')
    const workloads = {
        '20k settled awaits': () => state.doString('local n = 0 for i=1,20000 do n = n + ready:await() end return n'),
        '20k JS to Lua calls': () => {
            for (let i = 0; i < 20000; i++) assert.equal(addLua(i, 1), i + 1)
        },
        '20k Lua to JS calls': () => state.doStringSync('local n = 0 for i=1,20000 do n = add(n, 1) end return n'),
        '1k async entries': async () => {
            for (let i = 0; i < 1000; i++) assert.equal(await state.doString('return 1'), 1)
        },
        'CPU loop': () => state.doStringSync('local n = 0 for i=1,1000000 do n = n + i end return n'),
    }
    const timings = {}
    for (const [name, run] of Object.entries(workloads)) {
        for (let i = 0; i < 3; i++) await run()
        const samples = []
        for (let i = 0; i < 7; i++) {
            const start = performance.now()
            await run()
            samples.push(performance.now() - start)
        }
        timings[name] = Number(median(samples).toFixed(2))
    }

    const heapSamples = []
    const bufferSamples = []
    const luaSamples = []
    for (let sample = 0; sample < 5; sample++) {
        let release
        state.set(
            'gate',
            new Promise((resolve) => {
                release = resolve
            }),
        )
        state.gc.collect()
        global.gc?.()
        const before = process.memoryUsage()
        const luaBefore = state.memory.used
        const runs = Array.from({ length: 1000 }, () => state.doString('gate:await() return 1'))
        await new Promise((resolve) => setTimeout(resolve, 20))
        global.gc?.()
        const during = process.memoryUsage()
        heapSamples.push(during.heapUsed - before.heapUsed)
        bufferSamples.push(during.arrayBuffers - before.arrayBuffers)
        luaSamples.push(state.memory.used - luaBefore)
        release()
        assert.ok((await Promise.all(runs)).every((value) => value === 1))
    }
    console.log(
        JSON.stringify({
            engine,
            medianMs: timings,
            parked1000: { jsHeapBytes: median(heapSamples), arrayBufferBytes: median(bufferSamples), luaBytes: median(luaSamples) },
        }),
    )
    state.close()
}
