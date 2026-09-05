// Adversarial for the linear-memory C stack. Lua->Lua calls do not recurse in C, so recursion goes
// through pcall (a lua_longjmp with a setjmp buffer per level on the C stack) and gsub (a
// luaL_Buffer per level), each level verifying its own C-stack data after the inner levels ran.
const mitigate = process.argv[3] === 'mitigate'
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
const pcallAsync = async (L, ...args) => {
  if (!mitigate) return pcallRaw(L, ...args)
  const region = M._malloc(REGION)
  M.stackRestore(region + REGION)
  try { const p = pcallRaw(L, ...args); M.stackRestore(mainSP); return await p }
  finally { M.stackRestore(mainSP); M._free(region) }
}
const suspending = (fn) => new WebAssembly.Suspending(mitigate
  ? async (...args) => { const sp = M.stackSave(); try { return await fn(...args) } finally { M.stackRestore(sp) } }
  : fn)
const run = async (L, code) => { const top = M._lua_gettop(L); load(L, code); const st = await pcallAsync(L, 0, 1, 0, 0, 0); const v = tostr(L, -1); M._lua_settop(L, top); if (st) throw new Error(`status ${st}: ${v}`); return v }
const def = (L, name, ptr) => { M._lua_pushcclosure(L, ptr, 0); const p = cstr(name); M._lua_setglobal(L, p); M._free(p) }
const sleepPtr = M.addFunction(suspending(async (L) => { const ms = M._lua_tonumberx(L, 1, 0); await sleep(ms); M._lua_pushinteger(L, 42n); return 1 }), 'ii')
const mk = () => { const L = newState(); def(L, 'jspiSleep', sleepPtr); return L }
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
const A = mk(), B = mk()
for (let round = 1; round <= 3; round++) {
  try {
    const r = await Promise.all([
      run(A, `pcall(function() jspiSleep(2) end) ${deep(0, 40, "A")}`),   // shallow park, then deep C recursion while B is parked
      run(B, deep(30, 40, "B")),                     // deep C recursion, then park for 30ms
    ])
    console.log(`round ${round}:`, r)
  } catch (e) { console.log(`round ${round}: FAILED:`, `${e?.constructor?.name}: ${String(e?.message ?? e)}`.slice(0, 160)) }
}
try {
  // Single run: park deep, and while parked let the main JS thread make deep sync calls.
  const parked = run(A, deep(20, 40, "A"))
  load(B, deep(0, 40, "B").replace('jspiSleep(0)', '')); const st = M._lua_pcallk(B, 0, 1, 0, 0, 0); const v = tostr(B, -1); M._lua_settop(B, 0)
  console.log('deep sync call while A parked deep:', st, v, '| A ->', await parked)
} catch (e) { console.log('sync-while-parked FAILED:', `${e?.constructor?.name}: ${String(e?.message ?? e)}`.slice(0, 160)) }
