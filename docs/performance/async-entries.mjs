import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
const paths = process.argv.slice(2)
if (paths.length !== 2) throw new Error('Pass absolute paths to baseline and candidate index.js files')
for (const engine of ['yield', 'jspi']) {
    const runtimes = await Promise.all(paths.map(async (path) => (await import(path)).LuaRuntime.load({ async: engine })))
    const states = runtimes.map((lua) => lua.createState())
    const samples = [[], []]
    for (let round = 0; round < 30; round++)
        for (const variant of round % 2 ? [1, 0] : [0, 1]) {
            const start = performance.now()
            for (let i = 0; i < 1000; i++) assert.equal(await states[variant].doString('return 1'), 1)
            if (round >= 10) samples[variant].push(performance.now() - start)
        }
    const medians = samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1])
    console.log({ engine, medians, improvement: 1 - medians[1] / medians[0] })
    states.forEach((state) => state.close())
}
