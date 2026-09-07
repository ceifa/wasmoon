// Drives the raw Emscripten glue (no wasmoon TS layer) so it can point at an experimental build.
const glue = process.argv[2]
const { default: init } = await import(glue)
const M = await init({})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cstr = (s) => M.stringToNewUTF8(s)
const tostr = (L, i) => M.UTF8ToString(M._lua_tolstring(L, i, 0))
const newState = () => { const L = M._luaL_newstate(); M._luaL_openselectedlibs(L, 0xffff, 0); return L }
const load = (L, code) => { const p = cstr(code); const n = M.lengthBytesUTF8(code); const st = M._luaL_loadbufferx(L, p, n, p, 0); M._free(p); if (st) throw new Error('load: ' + tostr(L, -1)) }
const pcallAsync = WebAssembly.promising(M._lua_pcallk)
const run = async (L, code) => { const top = M._lua_gettop(L); load(L, code); const st = await pcallAsync(L, 0, 1, 0, 0, 0); const v = tostr(L, -1); M._lua_settop(L, top); if (st) throw new Error(`status ${st}: ${v}`); return v }
const runSync = (L, code) => { const top = M._lua_gettop(L); load(L, code); const st = M._lua_pcallk(L, 0, 1, 0, 0, 0); const v = tostr(L, -1); M._lua_settop(L, top); if (st) throw new Error(`status ${st}: ${v}`); return v }
const def = (L, name, ptr) => { M._lua_pushcclosure(L, ptr, 0); const p = cstr(name); M._lua_setglobal(L, p); M._free(p) }

const fns = {
  jspiSleep: M.addFunction(new WebAssembly.Suspending(async (L) => { const ms = M._lua_tonumberx(L, 1, 0); await sleep(ms); M._lua_pushinteger(L, 42n); return 1 }), 'ii'),
  jspiSync: M.addFunction(new WebAssembly.Suspending((L) => { M._lua_pushinteger(L, 1n); return 1 }), 'ii'),
  jspiMicro: M.addFunction(new WebAssembly.Suspending(async (L) => { await Promise.resolve(); M._lua_pushinteger(L, 1n); return 1 }), 'ii'),
  jspiThrow: M.addFunction(new WebAssembly.Suspending(async (L) => { await sleep(1); const p = cstr('boom after suspend'); M._lua_pushstring(L, p); M._free(p); return M._lua_error(L) }), 'ii'),
  plainFn: M.addFunction((L) => { M._lua_pushinteger(L, 1n); return 1 }, 'ii'),
}
const mk = () => { const L = newState(); for (const [n, p] of Object.entries(fns)) def(L, n, p); return L }
const L1 = mk(), L2 = mk()
const t = async (name, f) => { try { console.log(`[${name}]`, await f()) } catch (e) { console.log(`[${name}] FAILED:`, e.message.split('\n')[0]) } }

await t('await in C function', () => run(L1, `return jspiSleep(5) * 2`))
await t('inside table.sort comparator', () => run(L1, `local t={3,2,1} table.sort(t, function(a,b) jspiSleep(1) return a<b end) return table.concat(t,",")`))
await t('inside gsub callback', () => run(L1, `return (("abc"):gsub(".", function(c) jspiSleep(1) return c:upper() end))`))
await t('inside coroutine, no host yield', () => run(L1, `local co=coroutine.wrap(function() return jspiSleep(1) end) return co()`))
await t('lua error after suspend is pcall-able', () => run(L1, `local ok, e = pcall(jspiThrow) return tostring(ok) .. " " .. tostring(e)`))
await t('lua error() after suspend in Lua', () => run(L1, `local ok, e = pcall(function() jspiSleep(1) error("boom") end) return tostring(e)`))
await t('coroutine.yield still works alongside', () => run(L1, `local co = coroutine.create(function() jspiSleep(1) coroutine.yield(7) return 8 end) local _, a = coroutine.resume(co) local _, b = coroutine.resume(co) return a .. b`))
await t('sync pcall with a suspending import (expected to fail)', () => runSync(L1, `return jspiSleep(1)`))
await t('sync pcall with non-suspending Suspending import', () => runSync(L1, `return jspiSync()`))

const stress = (L, ms) => run(L, `for i=1,40 do local r = ("x"):rep(64):gsub(".", function() jspiSleep(${ms}) return "y" end) assert(r == ("y"):rep(64), "clobbered") end return "ok"`)
await t('two states interleaving suspended runs (shadow stack)', () => Promise.all([stress(L1, 1), stress(L2, 2)]))
await t('same state, two concurrent promising pcalls', () => Promise.all([stress(L1, 1), stress(L1, 2)]))
// Deep C recursion live across suspensions on both sides.
const deep = (L, ms) => run(L, `local function f(n) if n == 0 then jspiSleep(${ms}) return 0 end return 1 + tonumber(("%d"):format(f(n-1))) end for i=1,20 do assert(f(150) == 150) end return "ok"`)
await t('deep interleaved recursion across suspensions', () => Promise.all([deep(L1, 1), deep(L2, 2)]))

const time = async (name, f) => { const s = performance.now(); await f(); console.log(`  ${name}: ${(performance.now() - s).toFixed(1)} ms`) }
await time('100k Suspending imports that never suspend (promising pcall)', () => run(L1, `for i=1,100000 do jspiSync() end`))
await time('100k plain imports (promising pcall)', () => run(L1, `for i=1,100000 do plainFn() end`))
await time('100k plain imports (sync pcall)', async () => runSync(L1, `for i=1,100000 do plainFn() end`))
await time('10k promising pcall round trips', async () => { for (let i = 0; i < 10000; i++) await run(L1, `return 1`) })
await time('10k sync pcall round trips', async () => { for (let i = 0; i < 10000; i++) runSync(L1, `return 1`) })
await time('10k suspensions on resolved promise', () => run(L1, `for i=1,10000 do jspiMicro() end`))
await time('1k suspensions on setTimeout(0)', () => run(L1, `for i=1,1000 do jspiSleep(0) end`))
await time('heapsort-ish CPU loop, sync pcall', async () => runSync(L1, `local t={} for i=1,200000 do t[i]=(i*7919)%1000 end table.sort(t)`))
await time('heapsort-ish CPU loop, promising pcall', () => run(L1, `local t={} for i=1,200000 do t[i]=(i*7919)%1000 end table.sort(t)`))
