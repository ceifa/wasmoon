import { LuaRuntime } from '../../../dist/index.js'
const lua = await LuaRuntime.load()
const M = lua.module
const state = lua.createState({ inject: true })
const time = (name, f, n = 5) => { let best = Infinity; for (let i = 0; i < n; i++) { const s = performance.now(); f(); best = Math.min(best, performance.now() - s) } console.log(`  ${name}: ${best.toFixed(1)} ms (best of ${n})`) }

console.log('== callbacks: lua_pcallk vs lua_resume on a pooled thread ==')
state.doStringSync('function f(x) return x + 1 end')
const T = state.newThread()
const N = 100000
time(`${N} lua_pcallk calls`, () => { for (let i = 0; i < N; i++) { M.lua_getglobal(T.address, 'f'); M.lua_pushinteger(T.address, i); M.lua_pcallk(T.address, 1, 1, 0, 0, null); M.lua_settop(T.address, 0) } })
time(`${N} lua_resume calls`, () => { for (let i = 0; i < N; i++) { M.lua_getglobal(T.address, 'f'); M.lua_pushinteger(T.address, i); M.lua_resume(T.address, null, 1, M.resultCountScratch); M.lua_settop(T.address, 0) } })
const jsF = state.get('f')
time(`${N} calls through today's getValue wrapper`, () => { for (let i = 0; i < N; i++) jsF(i) })

console.log('== today: memory for 1000 concurrently parked doString awaits ==')
let release; const gate = new Promise((r) => { release = r })
state.set('wait', () => gate)
global.gc?.(); const before = process.memoryUsage(); const heapBefore = M.emscripten.HEAPU8.length
const runs = []; for (let i = 0; i < 1000; i++) runs.push(state.doString('wait():await() return 1'))
await new Promise((r) => setTimeout(r, 20)); global.gc?.(); const during = process.memoryUsage()
console.log(`  1000 parked runs: rss +${((during.rss - before.rss) / 1048576).toFixed(1)} MB, js heap +${((during.heapUsed - before.heapUsed) / 1048576).toFixed(1)} MB, wasm memory grew ${(M.emscripten.HEAPU8.length - heapBefore) / 1048576} MB`)
const s = performance.now(); release(); await Promise.all(runs); console.log(`  resuming all 1000: ${(performance.now() - s).toFixed(1)} ms`)
time('1000 doString of "return 1" (run setup cost today)', () => { const ps = []; for (let i = 0; i < 1000; i++) ps.push(state.doString('return 1')) }, 3)
state.close()
