import { performance } from 'node:perf_hooks'
import { statSync } from 'node:fs'
const paths = process.argv.slice(2)
if (paths.length !== 2) throw new Error('Pass absolute paths to baseline and candidate index.js files')
const runtimes = await Promise.all(paths.map(async (path) => (await import(path)).LuaRuntime.load()))
const values = [
    {},
    { id: 1, name: 'item', active: true },
    Array.from({ length: 2000 }, (_, id) => ({ id, name: `item${id}`, active: true })),
]
for (const [index, value] of values.entries()) {
    const states = runtimes.map((runtime) => runtime.createState({ objects: 'copy' }))
    const samples = [[], []]
    const count = index === 2 ? 100 : 20000
    for (let round = 0; round < 24; round++) {
        for (const variant of round % 2 ? [1, 0] : [0, 1]) {
            const state = states[variant]
            const start = performance.now()
            for (let i = 0; i < count; i++) {
                state.pushValue(value)
                state.pop()
            }
            const elapsed = performance.now() - start
            if (round >= 6) samples[variant].push(elapsed)
        }
    }
    const medians = samples.map((sample) => sample.sort((a, b) => a - b)[sample.length >> 1])
    console.log(JSON.stringify({ index, count, medians, improvement: 1 - medians[1] / medians[0] }))
    states.forEach((state) => state.close())
}
console.log(paths.map((path) => ({ path, bytes: statSync(path).size })))
