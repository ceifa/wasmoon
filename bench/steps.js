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

Promise.resolve()
    .then(createFactory)
    .then(loadWasm)
    .then(createEngine)
    .then(createEngineWithoutSuperpowers)
