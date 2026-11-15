import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
const paths = process.argv.slice(2)
if (paths.length !== 2) throw new Error('Pass absolute paths to baseline and candidate index.js files')
const runtimes = await Promise.all(paths.map(async (path) => (await import(path)).LuaRuntime.load()))
const workloads = [
    ['arithmetic', 'return function() local sum=0; for i=1,1000000 do sum=sum+i end return sum end', 500000500000],
    [
        'table',
        'return function() local t={}; for i=1,100000 do t[i]=i end local sum=0; for i=1,#t do sum=sum+t[i] end return sum end',
        5000050000,
    ],
    [
        'calls',
        'local function add(a,b) return a+b end; return function() local sum=0; for i=1,200000 do sum=add(sum,i) end return sum end',
        20000100000,
    ],
    [
        'strings',
        'return function() local t={}; for i=1,10000 do t[i]=string.format("item:%d",i) end return #table.concat(t,",") end',
        98893,
    ],
    ['heapsort', readFileSync(new URL('../../bench/heapsort.lua', import.meta.url), 'utf8'), 10],
]
for (const [name, source, expected] of workloads) {
    const states = runtimes.map((lua) => lua.createState())
    for (const state of states) state.doStringSync('math.randomseed(1)')
    const fns = states.map((state) => state.doStringSync(source))
    const samples = [[], []]
    for (let round = 0; round < 30; round++)
        for (const variant of round % 2 ? [1, 0] : [0, 1]) {
            const start = performance.now()
            const result = fns[variant]()
            const elapsed = performance.now() - start
            assert.equal(result, expected)
            if (round >= 10) samples[variant].push(elapsed)
        }
    const medians = samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1])
    console.log({ name, medians, improvement: 1 - medians[1] / medians[0] })
    states.forEach((state) => state.close())
}
