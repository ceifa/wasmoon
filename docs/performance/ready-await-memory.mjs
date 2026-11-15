if (!global.gc || !process.argv[2]) throw new Error('Use --expose-gc and pass an absolute path to index.js')
const { LuaRuntime } = await import(process.argv[2])
const lua = await LuaRuntime.load()
const results = []
for (let depth = 0; depth < 7; depth++) {
    const state = lua.createState()
    let release
    state.set(
        'gate',
        new Promise((resolve) => {
            release = resolve
        }),
    )
    state.gc.collect()
    global.gc()
    const before = process.memoryUsage()
    const runs = Array.from({ length: 1000 }, () =>
        state.doString('gate:await() return 1').then(
            () => {},
            () => {},
        ),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    for (let i = 0; i < depth; i++) await Promise.resolve()
    global.gc()
    const during = process.memoryUsage()
    results.push({ depth, heap: during.heapUsed - before.heapUsed, buffers: during.arrayBuffers - before.arrayBuffers })
    if (process.argv.includes('--close-before-resume')) state.close()
    await Promise.all(runs)
    state.close()
}
console.log(JSON.stringify({ path: process.argv[2], results }))
