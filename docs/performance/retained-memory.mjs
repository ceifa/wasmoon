import { getHeapCodeStatistics } from 'node:v8'

if (!global.gc || !process.argv[2]) throw new Error('Use --expose-gc and pass an absolute path to index.js')
const { LuaRuntime } = await import(process.argv[2])
const runtimes = []
for (let i = 0; i < 20; i++) {
    const lua = await LuaRuntime.load()
    const state = lua.createState({ objects: 'copy' })
    state.doStringSync('data={}; for i=1,2000 do data[i]=i end')
    for (let j = 0; j < 20; j++) state.get('data')
    if (process.argv.includes('--fill-cache')) {
        // For a 31-based hash, the final two bytes add every integer from 0 through 255.
        // This covers every bucket in caches of up to 256 slots. Adjacent duplicates exercise
        // second-touch admission; two separate streaming passes would not fill the cache.
        state.doStringSync(`
            cacheStrings = {}
            for i = 0, 255 do
                local s = string.rep('a', 30) .. string.char(i // 31, i % 31)
                cacheStrings[2*i+1] = s
                cacheStrings[2*i+2] = s
            end
        `)
        state.get('cacheStrings')
        state.doStringSync('cacheStrings=nil; collectgarbage("collect")')
    }
    runtimes.push({ lua, state })
}
for (let i = 0; i < 5; i++) global.gc()
console.log({
    path: process.argv[2],
    heapUsed: process.memoryUsage().heapUsed,
    external: process.memoryUsage().external,
    wasmHeap: runtimes[0].lua.module.emscripten.HEAPU8.length,
    cacheSlots: runtimes[0].lua.module.decodedStrings?.filter(Boolean).length,
    code: getHeapCodeStatistics(),
})
