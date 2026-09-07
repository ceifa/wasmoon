const { default: init } = await import(process.argv[2])
const M = await init({})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cstr = (s) => M.stringToNewUTF8(s)
const newState = () => { const L = M._luaL_newstate(); M._luaL_openselectedlibs(L, 0xffff, 0); return L }
const load = (L, code) => { const p = cstr(code); M._luaL_loadbufferx(L, p, M.lengthBytesUTF8(code), p, 0); M._free(p) }
const pcallRaw = WebAssembly.promising(M._lua_pcallk)
const log = (tag) => console.log(tag.padEnd(46), 'SP =', M.stackSave())
log('main, before anything')
const ptr = M.addFunction(new WebAssembly.Suspending(async (L) => {
  const name = M.UTF8ToString(M._lua_tolstring(L, 1, 0)); const ms = M._lua_tonumberx(L, 2, 0)
  log(`import entry (${name})`)
  await sleep(ms)
  log(`import after await, before resume (${name})`)
  M._lua_pushinteger(L, 1n); return 1
}), 'ii')
const def = (L) => { M._lua_pushcclosure(L, ptr, 0); const p = cstr('susp'); M._lua_setglobal(L, p); M._free(p) }
const A = newState(), B = newState(); def(A); def(B)
load(A, `susp("A shallow", 5) local function f(n) if n == 0 then susp("A deep", 5) return end f(n-1) end f(60)`)
load(B, `local function f(n) if n == 0 then susp("B deep", 20) return end f(n-1) end f(60)`)
const pa = pcallRaw(A, 0, 0, 0, 0, 0); log('main, after A suspended')
const pb = pcallRaw(B, 0, 0, 0, 0, 0); log('main, after B suspended')
await Promise.all([pa, pb]); log('main, both done')
