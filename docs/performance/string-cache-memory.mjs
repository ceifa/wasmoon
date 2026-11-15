// Worst case for the decoded string cache: every slot filled with a 32 byte string, read twice so
// it is kept. Reports the JS heap the cache retains per runtime after a full GC.
if (!global.gc) throw new Error('use --expose-gc')
const { LuaRuntime } = await import(process.argv[2])
const lua = await LuaRuntime.load()
const state = lua.createState()
// 4096 distinct 32-char ASCII strings, each read twice: far more than 256 slots, so every slot ends up holding one.
state.doStringSync('t = {}; for i = 1, 4096 do t[i] = string.format("%032d", i) end')
const read = () => { for (let i = 0; i < 2; i++) state.doStringSync('return t[' + (i + 1) + ']') }
for (let g = 0; g < 5; g++) global.gc()
const before = process.memoryUsage().heapUsed
for (let i = 1; i <= 4096; i++) { state.doStringSync(`return t[${i}]`); state.doStringSync(`return t[${i}]`) }
for (let g = 0; g < 5; g++) global.gc()
const after = process.memoryUsage().heapUsed
console.log({ path: process.argv[2].split('/').slice(-2).join('/'), heapDelta: after - before })
state.close()
