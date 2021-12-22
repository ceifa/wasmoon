const { readFileSync } = require("fs")
const { resolve } = require("path")

const wasmoon = require("../dist/index")

const heapsort = readFileSync(resolve(__dirname, 'heapsort.lua'), 'utf-8')

const createFactory = () => {
    console.time("Create factory")
    new wasmoon.LuaFactory()
    console.timeEnd("Create factory")
}

const loadWasm = async () => {
    console.time("Load wasm")
    await new wasmoon.LuaFactory().getLuaModule()
    console.timeEnd("Load wasm")
}

const createEngine = async () => {
    console.time("Create engine")
    await new wasmoon.LuaFactory().createEngine()
    console.timeEnd("Create engine")
}

const createEngineWithoutSuperpowers = async () => {
    console.time("Create engine without superpowers")
    await new wasmoon.LuaFactory().createEngine({
        injectObjects: false,
        enableProxy: false,
        openStandardLibs: false
    })
    console.timeEnd("Create engine without superpowers")
}

const runHeapsort = async () => {
    const state = await new wasmoon.LuaFactory().createEngine()

    console.time("Run plain heapsort")
    state.global.lua.luaL_loadstring(state.global.address, heapsort)
    state.global.lua.lua_pcallk(state.global.address, 0, 0, 0, 0, null)
    console.timeEnd("Run plain heapsort")
}

const runInteropedHeapsort = async () => {
    const state = await new wasmoon.LuaFactory().createEngine()

    console.time("Run interoped heapsort")
    const runHeapsort = await state.doString(heapsort)
    await runHeapsort()
    console.timeEnd("Run interoped heapsort")
}

const insertComplexObjects = async () => {
    const state = await new wasmoon.LuaFactory().createEngine()
    const obj1 = {
        hello: 'world',
    }
    obj1.self = obj1
    const obj2 = {
        hello: 'everybody',
        array: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        fn: async () => {
            return 'hello'
        }
    }
    obj2.self = obj2

    console.time("Insert complex objects")
    state.global.set('obj', { obj1, obj2 })
    console.timeEnd("Insert complex objects")
}

const insertComplexObjectsWithoutProxy = async () => {
    const state = await new wasmoon.LuaFactory().createEngine({
        enableProxy: false
    })
    const obj1 = {
        hello: 'world',
    }
    obj1.self = obj1
    const obj2 = {
        hello: 'everybody',
        array: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        fn: async () => {
            return 'hello'
        }
    }
    obj2.self = obj2

    console.time("Insert complex objects without proxy")
    state.global.set('obj', { obj1, obj2 })
    console.timeEnd("Insert complex objects without proxy")
}

const getComplexObjects = async () => {
    const state = await new wasmoon.LuaFactory().createEngine()
    await state.doString(`
        local obj1 = {
            hello = 'world',
        }
        obj1.self = obj1
        local obj2 = {
            5,
            hello = 'everybody',
            array = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
            fn = function()
                return 'hello'
            end
        }
        obj2.self = obj2
        obj = { obj1, obj2 }
    `)

    console.time("Get complex objects")
    const obj = state.global.get('obj')
    console.timeEnd("Get complex objects")
}

Promise.resolve()
    .then(createFactory)
    .then(loadWasm)
    .then(createEngine)
    .then(createEngineWithoutSuperpowers)
    .then(runHeapsort)
    .then(runInteropedHeapsort)
    .then(insertComplexObjects)
    .then(insertComplexObjectsWithoutProxy)
    .then(getComplexObjects)
