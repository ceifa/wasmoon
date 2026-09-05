// Raw-glue measurements. Usage: node perf-raw.mjs <glue.js> [jspi]
const { default: init } = await import(process.argv[2])
const jspi = process.argv[3] === 'jspi'
const M = await init({})
const cstr = (s) => M.stringToNewUTF8(s)
const tostr = (L, i) => M.UTF8ToString(M._lua_tolstring(L, i, 0))
const L = M._luaL_newstate(); M._luaL_openselectedlibs(L, 0xffff, 0)
const load = (T, code) => { const p = cstr(code); const st = M._luaL_loadbufferx(T, p, M.lengthBytesUTF8(code), p, 0); M._free(p); if (st) throw new Error('load: ' + tostr(T, -1)) }
const runSync = (T, code) => { const top = M._lua_gettop(T); load(T, code); const st = M._lua_pcallk(T, 0, 1, 0, 0, 0); const v = tostr(T, -1); M._lua_settop(T, top); if (st) throw new Error(`status ${st}: ${v}`); return v }
const time = (name, f, n = 5) => { let best = Infinity; for (let i = 0; i < n; i++) { const s = performance.now(); f(); best = Math.min(best, performance.now() - s) } console.log(`  ${name}: ${best.toFixed(1)} ms (best of ${n})`) }
const heapsort = (await import('node:fs')).readFileSync(new URL('../../../bench/heapsort.lua', import.meta.url), 'utf8')

console.log('== CPU / error paths ==')
runSync(L, 'hs = (function() ' + heapsort + ' end)()'); time('heapsort.lua', () => runSync(L, 'return hs()'))
time('100k pcall(error) round trips', () => runSync(L, `for i=1,100000 do pcall(error, "x") end`))
time('100k pcall(f) no error', () => runSync(L, `local f = function() end for i=1,100000 do pcall(f) end`))
time('100k coroutine.yield/resume (Lua only)', () => runSync(L, `local co = coroutine.wrap(function() while true do coroutine.yield() end end) for i=1,100000 do co() end`))
// A C function that yields: lua_yieldk from C is a longjmp. Use a JS import that yields.
const yieldPtr = M.addFunction((T) => M._lua_yieldk(T, 0, 0, 0), 'ii')
M._lua_pushcclosure(L, yieldPtr, 0); { const p = cstr('cyield'); M._lua_setglobal(L, p); M._free(p) }
time('100k yields from a C (JS) function via longjmp', () => runSync(L, `local co = coroutine.wrap(function() while true do cyield() end end) for i=1,100000 do co() end`))
const errPtr = M.addFunction((T) => { const p = cstr('e'); M._lua_pushstring(T, p); M._free(p); return M._lua_error(T) }, 'ii')
M._lua_pushcclosure(L, errPtr, 0); { const p = cstr('cerror'); M._lua_setglobal(L, p); M._free(p) }
time('100k lua_error from a C (JS) function', () => runSync(L, `for i=1,100000 do pcall(cerror) end`))

console.log('== C stack depth ==')
const minSP = { v: Infinity }
const probePtr = M.addFunction((T) => { minSP.v = Math.min(minSP.v, M.stackSave()); return 0 }, 'ii')
M._lua_pushcclosure(L, probePtr, 0); { const p = cstr('probe'); M._lua_setglobal(L, p); M._free(p) }
const top = M.stackSave()
for (const [name, code] of [
  ['pcall recursion to the C limit', `local n = 0 local function f() n = n + 1 probe() local ok, e = pcall(f) if not ok and n == 1 then return e end end f() return n`],
  ['gsub recursion to the C limit', `local n = 0 local function f() n = n + 1 probe() local ok, e = pcall(function() ("a"):gsub("a", f) end) end f() return n`],
  ['string.format/ tostring / sort nesting', `local n = 0 local function f() n = n + 1 probe() pcall(table.sort, {2,1}, function(a,b) f() return a<b end) end f() return n`],
]) { minSP.v = Infinity; let r; try { r = runSync(L, code) } catch (e) { r = e.message.slice(0, 40) } console.log(`  ${name}: ${(top - minSP.v).toLocaleString()} bytes of C stack, result ${String(r).slice(0, 60)}`) }

if (jspi) {
  console.log('== JSPI: memory for N concurrently suspended runs (no region management, suspend-all then resume-all) ==')
  const pcallAsync = WebAssembly.promising(M._lua_pcallk)
  let release
  const gate = new Promise((r) => { release = r })
  const waitPtr = M.addFunction(new WebAssembly.Suspending(async (T) => { await gate; return 0 }), 'ii')
  const N = 1000
  M._lua_checkstack(L, N + 10); const threads = []
  for (let i = 0; i < N; i++) { const T = M._lua_newthread(L); M._lua_pushcclosure(T, waitPtr, 0); const p = cstr('wait'); M._lua_setglobal(T, p); M._free(p); threads.push(T) }
  // threads stay anchored on the main stack
  global.gc?.(); const before = process.memoryUsage()
  const heapBefore = M.HEAPU8.length
  const runs = threads.map((T) => { load(T, `wait() return 1`); return pcallAsync(T, 0, 1, 0, 0, 0) })
  global.gc?.(); const during = process.memoryUsage()
  console.log(`  ${N} suspended runs: rss +${((during.rss - before.rss) / 1048576).toFixed(1)} MB, js heap +${((during.heapUsed - before.heapUsed) / 1048576).toFixed(1)} MB, external +${((during.external - before.external) / 1048576).toFixed(1)} MB, wasm memory grew ${(M.HEAPU8.length - heapBefore) / 1048576} MB`)
  const s = performance.now(); release(); await Promise.all(runs)
  console.log(`  resuming all ${N}: ${(performance.now() - s).toFixed(1)} ms`)
  // Cost of starting a promising run that completes synchronously, vs sync, on a fresh thread each time.
  const T = M._lua_newthread(L)
  time('10k promising pcall (sync completion) on one thread', () => { for (let i = 0; i < 10000; i++) { load(T, 'return 1'); pcallAsync(T, 0, 1, 0, 0, 0); M._lua_settop(T, 0) } })
  time('10k sync pcall on one thread', () => { for (let i = 0; i < 10000; i++) { load(T, 'return 1'); M._lua_pcallk(T, 0, 1, 0, 0, 0); M._lua_settop(T, 0) } })
  time('10k malloc/free of a 256 KB region', () => { for (let i = 0; i < 10000; i++) M._free(M._malloc(262144)) })
  time('10k malloc/free of a 64 KB region', () => { for (let i = 0; i < 10000; i++) M._free(M._malloc(65536)) })
}
