import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
const paths = process.argv.slice(2)
if (paths.length !== 2) throw new Error('Pass absolute paths to baseline and candidate index.js files')
const libs = await Promise.all(paths.map((path) => import(path)))
for (const engine of ['yield', 'jspi']) {
    const runtimes = await Promise.all(libs.map((lib) => lib.LuaRuntime.load({ async: engine })))
    const states = runtimes.map((lua) => lua.createState({ inject: true }))
    for (let i = 0; i < 2; i++) {
        const values = libs[i].LuaMultiReturn.of(1, 2, 3)
        states[i].set('values', Promise.resolve(values))
        states[i].set('callback', () => values)
    }
    for (const kind of ['callback', 'await']) {
        const code = `local n=0; for i=1,20000 do local a,b,c=${kind === 'callback' ? 'callback()' : 'values:await()'}; n=n+a+b+c end return n`
        const samples = [[], []]
        for (let round = 0; round < 30; round++)
            for (const variant of round % 2 ? [1, 0] : [0, 1]) {
                const start = performance.now()
                assert.equal(await states[variant].doString(code), 120000)
                if (round >= 10) samples[variant].push(performance.now() - start)
            }
        const medians = samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1])
        console.log({ engine, kind, medians, improvement: 1 - medians[1] / medians[0] })
    }
    states.forEach((state) => state.close())
}
