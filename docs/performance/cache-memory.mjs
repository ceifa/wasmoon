import assert from 'node:assert/strict'
for (const path of process.argv.slice(2)) {
    const { LuaRuntime, decorate } = await import(path)
    const lua = await LuaRuntime.load()
    const state = lua.createState({ inject: true, memory: { trace: true } })
    state.gc.stop()
    const memory = [state.memory.used]
    const object = { value: 1 }
    for (const [name, value] of [
        ['proxy', object],
        ['opaque', decorate(object, { as: 'userdata' })],
        ['promise', Promise.resolve(1)],
        ['error', new Error('example')],
    ]) {
        state.set(name, value)
        state.set(name + '2', value)
        assert.equal(state.doStringSync(`return rawequal(${name},${name}2)`), true)
    }
    memory.push(state.memory.used)
    state.doStringSync('proxy=nil; proxy2=nil; opaque=nil; opaque2=nil; promise=nil; promise2=nil; error=nil; error2=nil')
    state.gc.collect()
    memory.push(state.memory.used)
    assert.equal(state.getTop(), 0)
    console.log({ path, memory, wasmHeap: lua.module.emscripten.HEAPU8.length })
    state.close()
}
