import assert from 'node:assert/strict'

if (!global.gc || !process.argv[2]) throw new Error('Use --expose-gc and pass an absolute path to index.js')
const { LuaRuntime } = await import(process.argv[2])
const { module } = await LuaRuntime.load()
const count = 100_000
const refs = new Uint32Array(count)
const anchor = {}
const high = process.argv[3] === 'high'
let anchorRef = high ? undefined : module.ref(anchor)
const sample = () => {
    for (let i = 0; i < 5; i++) global.gc()
    return process.memoryUsage().heapUsed
}
// Warm the registration and release paths before measuring retained heap.
for (let i = 0; i < 10_000; i++) module.unref(module.ref({}))
const before = sample()
for (let i = 0; i < count; i++) refs[i] = module.ref({})
if (high) anchorRef = module.ref(anchor)
const live = sample()
for (const ref of refs) module.unref(ref)
const released = sample()
assert.equal(module.getRef(anchorRef), anchor)
assert.equal(module.getRefIndex(anchor), anchorRef)
console.log({ path: process.argv[2], anchor: high ? 'high' : 'low', live: live - before, released: released - before, heapUsed: released, wasmHeap: module.emscripten.HEAPU8.length })
module.unref(anchorRef)
