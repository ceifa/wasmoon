import { performance } from 'node:perf_hooks'
const paths = process.argv.slice(2)
if (paths.length !== 2) throw new Error('Pass absolute paths to baseline and candidate index.js files')
const runtimes = await Promise.all(paths.map(async (path) => (await import(path)).LuaRuntime.load()))
for (const options of [{}, { objects: 'copy' }, { inject: true }]) {
    const samples = [[], []]
    for (let round = 0; round < 30; round++) {
        for (const variant of round % 2 ? [1, 0] : [0, 1]) {
            const start = performance.now()
            for (let i = 0; i < 200; i++) runtimes[variant].createState(options).close()
            if (round >= 10) samples[variant].push(performance.now() - start)
        }
    }
    const medians = samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1])
    const memory = runtimes.map((lua) => {
        const state = lua.createState({ ...options, memory: { trace: true } })
        const used = state.memory.used
        state.close()
        return used
    })
    console.log({ options, medians, improvement: 1 - medians[1] / medians[0], memory })
}
