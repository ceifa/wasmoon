import { readFileSync } from 'fs'
import path from 'path'
import { Lua } from '../dist/index.js'
import assert from 'node:assert'

const heapsort = readFileSync(path.resolve(import.meta.dirname, 'heapsort.lua'), 'utf-8')

const createFactory = async () => {
    console.time('Create factory')
    await Lua.load()
    console.timeEnd('Create factory')
}

const createState = async () => {
    const lua = await Lua.load()

    console.time('Create state')
    lua.createState()
    console.timeEnd('Create state')
}

const createStateWithoutSuperpowers = async () => {
    const lua = await Lua.load()

    console.time('Create state without superpowers')
    lua.createState({
        injectObjects: false,
        enableProxy: false,
        openStandardLibs: false,
    })
    console.timeEnd('Create state without superpowers')
}

const runHeapsort = async () => {
    const lua = await Lua.load()
    const state = lua.createState()

    console.time('Run plain heapsort')
    state.global.lua.luaL_loadstring(state.global.address, heapsort)
    state.global.lua.lua_pcallk(state.global.address, 0, 1, 0, 0, null)
    state.global.lua.lua_pcallk(state.global.address, 0, 0, 0, 0, null)
    console.timeEnd('Run plain heapsort')
}

const runInteropedHeapsort = async () => {
    const lua = await Lua.load()
    const state = lua.createState()

    console.time('Run interoped heapsort')
    const runHeapsort = await state.doString(heapsort)
    assert(runHeapsort() === 10)
    console.timeEnd('Run interoped heapsort')
}

const insertComplexObjects = async () => {
    const lua = await Lua.load()
    const state = lua.createState()
    const obj1 = {
        hello: 'world',
    }
    obj1.self = obj1
    const obj2 = {
        hello: 'everybody',
        array: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        fn: () => {
            return 'hello'
        },
    }
    obj2.self = obj2

    console.time('Insert complex objects')
    state.global.set('obj', { obj1, obj2 })
    console.timeEnd('Insert complex objects')
}

const insertComplexObjectsWithoutProxy = async () => {
    const lua = await Lua.load()
    const state = lua.createState({
        enableProxy: false,
    })
    const obj1 = {
        hello: 'world',
    }
    obj1.self = obj1
    const obj2 = {
        hello: 'everybody',
        array: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        fn: () => {
            return 'hello'
        },
    }
    obj2.self = obj2

    console.time('Insert complex objects without proxy')
    state.global.set('obj', { obj1, obj2 })
    console.timeEnd('Insert complex objects without proxy')
}

const getComplexObjects = async () => {
    const lua = await Lua.load()
    const state = lua.createState()
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

    console.time('Get complex objects')
    state.global.get('obj')
    console.timeEnd('Get complex objects')
}

Promise.resolve()
    .then(createFactory)
    .then(createState)
    .then(createStateWithoutSuperpowers)
    .then(runHeapsort)
    .then(runInteropedHeapsort)
    .then(insertComplexObjects)
    .then(insertComplexObjectsWithoutProxy)
    .then(getComplexObjects)
    .catch(console.error)
