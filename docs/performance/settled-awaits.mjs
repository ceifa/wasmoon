import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
const paths = process.argv.slice(2)
if (paths.length !== 2) throw new Error('Pass absolute paths to baseline and candidate index.js files')
const runtimes = await Promise.all(paths.map(async (path) => (await import(path)).LuaRuntime.load()))
const states = runtimes.map((lua) => lua.createState())
for (const state of states) state.set('ready', Promise.resolve(1))
const samples = [[], []]
for (let round = 0; round < 30; round++)
    for (const variant of round % 2 ? [1, 0] : [0, 1]) {
        const start = performance.now()
        assert.equal(await states[variant].doString('local n=0; for i=1,20000 do n=n+ready:await() end return n'), 20000)
        if (round >= 10) samples[variant].push(performance.now() - start)
    }
const medians = samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1])
console.log({ medians, improvement: 1 - medians[1] / medians[0] })
states.forEach((state) => state.close())
