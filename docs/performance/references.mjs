import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
const paths = process.argv.slice(2)
if (paths.length !== 2) throw new Error('Pass absolute paths to baseline and candidate index.js files')
const modules = await Promise.all(paths.map(async (path) => (await (await import(path)).LuaRuntime.load()).module))
const values = Array.from({ length: 1000 }, () => ({}))
for (const mode of ['reuse', 'batch']) {
    const samples = [[], []]
    for (let round = 0; round < 30; round++)
        for (const variant of round % 2 ? [1, 0] : [0, 1]) {
            const module = modules[variant]
            const start = performance.now()
            for (let i = 0; i < 100; i++) {
                if (mode === 'reuse')
                    for (const value of values) {
                        const ref = module.ref(value)
                        module.unref(ref)
                    }
                else {
                    const refs = values.map((value) => module.ref(value))
                    for (const ref of refs) module.unref(ref)
                }
            }
            if (round >= 10) samples[variant].push(performance.now() - start)
        }
    const medians = samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1])
    console.log({ mode, medians, improvement: 1 - medians[1] / medians[0] })
    for (const module of modules) for (const value of values) assert.equal(module.getRefIndex(value), undefined)
}
