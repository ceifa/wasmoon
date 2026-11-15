import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { readFileSync, readdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
const paths = process.argv.slice(2)
if (paths.length !== 2) throw new Error('Pass absolute paths to baseline and candidate dist directories')
const runtimes = await Promise.all(paths.map(async (path) => (await import(`${path}/index.js`)).LuaRuntime.load()))
for (const source of [
    'data = {}; for i=1,2000 do data[i]=i end',
    'data = {}; for i=1,2000 do data[i]={id=i,name="item"..i,active=true} end',
    'data = {}; for i=1,2000 do data["item"..i]=i end',
]) {
    const states = runtimes.map((lua) => lua.createState({ objects: 'copy', memory: { trace: true } }))
    for (const state of states) state.doStringSync(source)
    assert.deepEqual(states[0].get('data'), states[1].get('data'))
    const samples = [[], []]
    for (let round = 0; round < 24; round++) {
        for (const variant of round % 2 ? [1, 0] : [0, 1]) {
            const start = performance.now()
            for (let i = 0; i < 100; i++) states[variant].get('data')
            if (round >= 6) samples[variant].push(performance.now() - start)
        }
    }
    const medians = samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1])
    console.log({ source, medians, improvement: 1 - medians[1] / medians[0], memory: states.map((s) => s.memory.used) })
    states.forEach((s) => s.close())
}
for (const path of paths) {
    let bytes = 0,
        gzip = 0
    for (const name of readdirSync(path, { recursive: true })) {
        if (!/\.(js|ts|wasm)$/.test(name)) continue
        const data = readFileSync(`${path}/${name}`)
        bytes += data.length
        gzip += gzipSync(data).length
    }
    console.log({ path, bytes, gzip })
}
