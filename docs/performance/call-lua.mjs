import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
const paths = process.argv.slice(2)
if (paths.length !== 2) throw new Error('Pass absolute paths to baseline and candidate index.js files')
const runtimes = await Promise.all(paths.map(async (path) => (await import(path)).LuaRuntime.load()))
for (const code of ['return function() end', 'return function(a,b) return a+b end', 'return function(a,b) return a,b end']) {
    const states = runtimes.map((lua) => lua.createState({ memory: { trace: true } }))
    const funcs = states.map((state) => state.doStringSync(code))
    const samples = [[], []]
    for (let round = 0; round < 30; round++) {
        for (const variant of round % 2 ? [1, 0] : [0, 1]) {
            let result
            const start = performance.now()
            for (let i = 0; i < 100000; i++) result = funcs[variant](1, 2)
            const elapsed = performance.now() - start
            assert.equal(result, code.includes('a+b') ? 3 : code.includes('a,b end') ? 1 : null)
            if (round >= 10) samples[variant].push(elapsed)
        }
    }
    const medians = samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1])
    console.log({ code, medians, improvement: 1 - medians[1] / medians[0], memory: states.map((s) => s.memory.used) })
    states.forEach((s) => s.close())
}
