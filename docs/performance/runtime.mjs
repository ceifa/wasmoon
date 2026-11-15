if (!global.gc) throw new Error('Run with --expose-gc')
import { performance } from 'node:perf_hooks'
const paths = process.argv.slice(2)
if (paths.length !== 2) throw new Error('Pass absolute paths to baseline and candidate index.js files')
const libraries = await Promise.all(paths.map((path) => import(path)))
const samples = [[], []]
for (let round = 0; round < 30; round++) {
    for (const variant of round % 2 ? [1, 0] : [0, 1]) {
        global.gc()
        const start = performance.now()
        for (let i = 0; i < 10; i++) {
            const lua = await libraries[variant].LuaRuntime.load()
            const state = lua.createState()
            state.doStringSync('return 1+1')
            state.close()
        }
        if (round >= 10) samples[variant].push(performance.now() - start)
    }
}
const medians = samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1])
console.log({ medians, improvement: 1 - medians[1] / medians[0] })
