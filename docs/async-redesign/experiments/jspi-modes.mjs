// Compares three ways of handling the linear-memory C stack under JSPI:
//   none   : nothing (known to corrupt)
//   region : a malloc'd stack region per promising run, SP saved/restored around each suspension
//   copy   : shared stack; on suspension copy out [sp, mainSP) and restore it before resuming
// Usage: node jspi-modes.mjs <glue.js> <none|region|copy>
const mode = process.argv[3]
const { default: init } = await import(process.argv[2])
const M = await init({})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cstr = (s) => M.stringToNewUTF8(s)
const tostr = (L, i) => M.UTF8ToString(M._lua_tolstring(L, i, 0))
const newState = () => { const L = M._luaL_newstate(); M._luaL_openselectedlibs(L, 0xffff, 0); return L }
const load = (L, code) => { const p = cstr(code); const st = M._luaL_loadbufferx(L, p, M.lengthBytesUTF8(code), p, 0); M._free(p); if (st) throw new Error('load: ' + tostr(L, -1)) }
const pcallRaw = WebAssembly.promising(M._lua_pcallk)
const REGION = 256 * 1024
const mainSP = M.stackSave()
let copiedBytes = 0, suspensions = 0
const pcallAsync = async (L, ...args) => {
  if (mode === 'copy') {
    // Restore whatever SP the caller had, so a run started from inside an active run's callback
    // hands the stack back to that run when it completes or first suspends.
    const entry = M.stackSave()
    const p = pcallRaw(L, ...args); M.stackRestore(entry); return p
  }
  if (mode !== 'region') return pcallRaw(L, ...args)
  const region = M._malloc(REGION)
  M.stackRestore(region + REGION)
  try { const p = pcallRaw(L, ...args); M.stackRestore(mainSP); return await p }
  finally { M.stackRestore(mainSP); M._free(region) }
}
const suspending = (fn) => new WebAssembly.Suspending(
  mode === 'region' ? async (...args) => { const sp = M.stackSave(); try { return await fn(...args) } finally { M.stackRestore(sp) } }
  : mode === 'copy' ? async (...args) => {
      const sp = M.stackSave()
      const saved = M.HEAPU8.slice(sp, mainSP)      // the frames this run needs back
      copiedBytes += saved.length; suspensions++
      try { return await fn(...args) } finally { M.HEAPU8.set(saved, sp); M.stackRestore(sp) }
    }
  : fn)
const run = async (L, code) => { const top = M._lua_gettop(L); load(L, code); const st = await pcallAsync(L, 0, 1, 0, 0, 0); const v = tostr(L, -1); M._lua_settop(L, top); if (st) throw new Error(`status ${st}: ${v}`); return v }
const def = (L, name, ptr) => { M._lua_pushcclosure(L, ptr, 0); const p = cstr(name); M._lua_setglobal(L, p); M._free(p) }
const sleepPtr = M.addFunction(suspending(async (L) => { await sleep(M._lua_tonumberx(L, 1, 0)); M._lua_pushinteger(L, 42n); return 1 }), 'ii')
const microPtr = M.addFunction(suspending(async (L) => { await Promise.resolve(); M._lua_pushinteger(L, 1n); return 1 }), 'ii')
const mk = () => { const L = newState(); def(L, 'jspiSleep', sleepPtr); def(L, 'jspiMicro', microPtr); return L }
const deep = (ms, depth, tag) => `
  local function f(n)
    if n == 0 then jspiSleep(${ms}) return "" end
    local mine = ("${tag}"):rep(200) .. ("%03d"):format(n)
    local inner
    local r = (mine):gsub("%d%d%d", function(d)
      local ok, v = pcall(function() return f(n - 1) end)
      if not ok then error(v, 0) end
      inner = v
      return d
    end, 1)
    assert(r == mine, "gsub buffer clobbered at level " .. n)
    return inner .. mine
  end
  local out = f(${depth})
  assert(#out == ${depth} * 203, "result length clobbered")
  return "ok"`
const A = mk(), B = mk(), C = mk()
const fmt = (e) => `${e?.constructor?.name}: ${String(e?.message ?? e)}`.slice(0, 120)
console.log(`mode: ${mode}`)
for (let round = 1; round <= 3; round++) {
  try {
    const r = await Promise.all([
      run(A, `pcall(function() jspiSleep(2) end) ${deep(0, 40, "A")}`),
      run(B, deep(30, 40, "B")),
      run(C, `for i = 1, 5 do pcall(function() jspiSleep(3) end) ${deep(1, 20, "C")} end return "ok"`),
    ])
    console.log(`  interleaving round ${round}:`, r.join(','))
  } catch (e) { console.log(`  interleaving round ${round}: FAILED:`, fmt(e)) }
}
// Nested start: a run started from inside another run's JS callback while that run is active.
try {
  let inner
  const startInner = M.addFunction((L) => { inner = run(C, deep(5, 30, "N")); return 0 }, 'ii'); def(A, 'startInner', startInner)
  const outer = run(A, `startInner() ${deep(2, 30, "O")}`)
  console.log('  nested start:', await outer, await inner)
} catch (e) { console.log('  nested start: FAILED:', fmt(e)) }
console.log(`  stack bytes copied per suspension (avg): ${suspensions ? Math.round(copiedBytes / suspensions).toLocaleString() : 'n/a'}`)

let s = performance.now(); await run(A, `for i=1,10000 do jspiMicro() end`)
console.log(`  10k suspensions on a settled promise: ${(performance.now() - s).toFixed(1)} ms`)
s = performance.now(); await run(A, `local function f(n) if n == 0 then for i=1,2000 do jspiMicro() end return end pcall(f, n-1) end f(30)`)
console.log(`  2k suspensions 30 pcall levels deep: ${(performance.now() - s).toFixed(1)} ms`)

// Memory for 1000 concurrently parked runs.
let release; const gate = new Promise((r) => { release = r })
const waitPtr = M.addFunction(suspending(async () => { await gate; return 0 }), 'ii')
const L0 = newState(); M._lua_checkstack(L0, 1100); const threads = []
for (let i = 0; i < 1000; i++) { const T = M._lua_newthread(L0); def(T, 'wait', waitPtr); threads.push(T) }
global.gc?.(); const before = process.memoryUsage(); const heapBefore = M.HEAPU8.length
const runs = threads.map((T) => { load(T, `wait() return 1`); return pcallAsync(T, 0, 1, 0, 0, 0) })
global.gc?.(); const during = process.memoryUsage()
console.log(`  1000 parked runs: rss +${((during.rss - before.rss) / 1048576).toFixed(1)} MB, js heap +${((during.heapUsed - before.heapUsed) / 1048576).toFixed(1)} MB, wasm memory +${((M.HEAPU8.length - heapBefore) / 1048576).toFixed(1)} MB`)
s = performance.now(); release(); await Promise.all(runs); console.log(`  resume all 1000: ${(performance.now() - s).toFixed(1)} ms`)
