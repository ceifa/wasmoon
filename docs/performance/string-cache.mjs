import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
const paths = process.argv.slice(2)
const runtimes = await Promise.all(paths.map(async (path) => (await import(path)).LuaRuntime.load()))
for (const length of [8, 24, 200]) {
    const value = 'abcdefghij'.repeat(Math.ceil(length / 10)).slice(0, length)
    const states = runtimes.map((lua) => lua.createState())
    const samples = [[], []]
    for (let round = 0; round < 30; round++) {
        for (const variant of round % 2 ? [1, 0] : [0, 1]) {
            const state = states[variant]
            const start = performance.now()
            for (let i = 0; i < 20000; i++) {
                state.set('value', value)
                if (state.get('value') !== value) throw new Error('mismatch')
            }
            if (round >= 6) samples[variant].push(performance.now() - start)
        }
    }
    const medians = samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1])
    console.log(JSON.stringify({ length, medians, improvement: 1 - medians[1] / medians[0] }))
    states.forEach((s) => s.close())
}
// Distinct keys streaming through: the cache's worst case.
{
    const states = runtimes.map((lua) => lua.createState({ objects: 'copy' }))
    for (const state of states) state.doStringSync('data = {}; for i=1,2000 do data["k"..i] = "v"..i end')
    const samples = [[], []]
    for (let round = 0; round < 30; round++) {
        for (const variant of round % 2 ? [1, 0] : [0, 1]) {
            const start = performance.now()
            for (let i = 0; i < 50; i++) assert.equal(Object.keys(states[variant].get('data')).length, 2000)
            if (round >= 6) samples[variant].push(performance.now() - start)
        }
    }
    const medians = samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1])
    console.log(JSON.stringify({ workload: 'distinct string keys and values', medians, improvement: 1 - medians[1] / medians[0] }))
    states.forEach((s) => s.close())
}
