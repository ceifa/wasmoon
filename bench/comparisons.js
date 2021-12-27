const { readFileSync } = require('fs')
const path = require('path')

const fengari = require('fengari')
const wasmoon = require('../dist/index')

const heapsort = readFileSync(path.resolve(__dirname, 'heapsort.lua'), 'utf-8')

const startFengari = () => {
    const state = fengari.lauxlib.luaL_newstate()

    console.time('Fengari')
    fengari.lauxlib.luaL_loadstring(state, heapsort)
    fengari.lua.lua_pcallk(state, 0, 0, 0, 0, null)
    console.timeEnd('Fengari')
}

const startWasmoon = async () => {
    const state = await new wasmoon.LuaFactory().createEngine()

    console.time('Wasmoon')
    state.global.lua.luaL_loadstring(state.global.address, heapsort)
    state.global.lua.lua_pcallk(state.global.address, 0, 0, 0, 0, null)
    console.timeEnd('Wasmoon')
}

Promise.resolve().then(startFengari).then(startWasmoon).catch(console.error)
