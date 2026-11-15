import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
const paths = process.argv.slice(2)
if (paths.length !== 2) throw new Error('Pass absolute paths to baseline and candidate index.js files')
const libraries = await Promise.all(paths.map((path) => import(path)))
const runtimes = await Promise.all(libraries.map(({ LuaRuntime }) => LuaRuntime.load()))
const samples = [[], []]
for (let round = 0; round < 30; round++) {
    for (const variant of round % 2 ? [1, 0] : [0, 1]) {
        const raw = runtimes[variant].module.emscripten
        const start = performance.now()
        for (let i = 0; i < 1000; i++) {
            const module = new libraries[variant].LuaModule(raw)
            assert.equal(module.lua_gettop, raw._lua_gettop)
            for (const name of ['sizeScratch', 'resultCountScratch', 'gcArgsScratch', 'interruptToken']) raw._free(module[name])
        }
        if (round >= 10) samples[variant].push(performance.now() - start)
    }
}
const medians = samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1])
console.log({ medians, improvement: 1 - medians[1] / medians[0] })
