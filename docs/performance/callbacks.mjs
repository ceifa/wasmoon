import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
const paths = process.argv.slice(2)
if (paths.length !== 2) throw new Error('Pass absolute paths to baseline and candidate index.js files')
const runtimes = await Promise.all(paths.map(async (path) => (await import(path)).LuaRuntime.load()))
for (const kind of ['callback', 'proxy']) {
    const states = runtimes.map((lua) => lua.createState())
    for (const state of states) {
        state.set('add', (a, b) => a + b)
        state.set('data', { nested: { value: 1 } })
        state.doStringSync(
            `function run() local sum=0; for i=1,100000 do sum=sum+${kind === 'callback' ? 'add(i,1)' : 'data.nested.value'} end return sum end`,
        )
    }
    const fns = states.map((state) => state.get('run'))
    const samples = [[], []]
    for (let round = 0; round < 40; round++) {
        for (const variant of round % 2 ? [1, 0] : [0, 1]) {
            const start = performance.now()
            const result = fns[variant]()
            const elapsed = performance.now() - start
            assert.equal(result, kind === 'callback' ? 5000150000 : 100000)
            if (round >= 10) samples[variant].push(elapsed)
        }
    }
    const medians = samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1])
    console.log({ kind, medians, improvement: 1 - medians[1] / medians[0] })
    states.forEach((state) => state.close())
}
