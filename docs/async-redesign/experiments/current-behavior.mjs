import { LuaRuntime } from '../../../dist/index.js'
const lua = await LuaRuntime.load()
const state = lua.createState({ inject: true })
state.set('sleep', (ms) => new Promise((r) => setTimeout(r, ms)))
const probe = async (name, code, opts) => {
  const t = Date.now()
  try { const r = await state.doString(code, opts); console.log(`[${name}] ok ->`, r, `${Date.now()-t}ms`) }
  catch (e) { console.log(`[${name}] ERR ->`, String(e.message).split('\n')[0], `${Date.now()-t}ms`) }
}
await probe('top-level yield of unrepresentable value', `coroutine.yield(io.stdout) return 1`)
await probe('top-level yield values discarded', `local a, b = coroutine.yield(1, 2) return a, b`)
await probe('await inside table.sort comparator', `local t = {3,2,1} table.sort(t, function(a,b) sleep(1):await() return a<b end) return t[1]`)
await probe('await inside gsub callback', `return (("abc"):gsub(".", function(c) sleep(1):await() return c:upper() end))`)
await probe('await inside __index metamethod', `local t = setmetatable({}, {__index=function(_, k) sleep(1):await() return k end}) return t.x`)
await probe('await inside promise:next callback', `return sleep(1):next(function() sleep(1):await() return 5 end):await()`)
await probe('await inside pcall', `local ok, v = pcall(function() sleep(1):await() return 7 end) return ok, v`)
await probe('await inside for-in iterator (Lua iter)', `local function it() sleep(1):await() return nil end for x in it do end return 9`)
state.set('callback', null)
await state.doString(`callback = function(x) sleep(1):await() return x * 2 end`)
try { console.log('[JS calls Lua fn that awaits] ->', await state.get('callback')(2)) } catch (e) { console.log('[JS calls Lua fn that awaits] ERR ->', e.message.split('\n')[0]) }
let fired = false; setTimeout(() => { fired = true }, 5)
state.set('fired', () => fired)
await probe('resolved await loop starves timers? (cap 20000 iterations)', `local n=0 while not fired() and n < 20000 do Promise.resolve(1):await() n=n+1 end return n, fired()`)
await probe('200 bare coroutine.yield() round trips', `for i=1,200 do coroutine.yield() end return 1`)
const ac = new AbortController(); setTimeout(() => ac.abort(), 10)
await probe('abort while parked on 300ms sleep', `sleep(300):await() return 1`, { signal: ac.signal })
await probe('timeout 10ms while parked on 300ms sleep', `sleep(300):await() return 1`, { timeout: 10 })
const t0 = Date.now()
const rs = await Promise.all([1,2,3].map(i => state.doString(`sleep(30):await() return ${i}`)))
console.log('[3 concurrent doString on one state] ->', rs, `${Date.now()-t0}ms`)
await probe('nested coroutine.resume of awaiting coroutine, no polling', `local co = coroutine.create(function() sleep(1):await() return 3 end) local ok, v = coroutine.resume(co) return ok, tostring(v), coroutine.status(co)`)
// cost of one await round trip on an already-resolved promise
await probe('10000 awaits of resolved promise (timing)', `local p = Promise.resolve(1) for i=1,10000 do p:await() end return 1`)
state.close()
