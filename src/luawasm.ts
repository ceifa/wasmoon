import initWasmModule from './lua/glue.js'
import './lua/glue.wasm'
import { LuaReturn, LuaState, LuaType } from './types'

interface LuaEmscriptenModule extends EmscriptenModule {
    cwrap: typeof cwrap
    addFunction: typeof addFunction
    FS: typeof FS
}

export default class LuaWasm {
    public module: LuaEmscriptenModule

    public async initialize(customName?: string) {
        this.module = <LuaEmscriptenModule>await initWasmModule({
            print: console.log,
            printErr: console.error,
            locateFile: (path: string, scriptDirectory: string) => {
                return customName || scriptDirectory + path
            }
        })
        this.bindWrappedFunctions()
    }

    public luaL_newstate: () => LuaState
    public luaL_openlibs: (L: LuaState) => void
    public luaL_loadstring: (L: LuaState, code: string) => LuaReturn
    public luaL_loadfilex: (L: LuaState, filename: string, mode: string) => LuaReturn
    public lua_getglobal: (L: LuaState, name: string) => LuaType
    public lua_tonumberx: (L: LuaState, idx: number, isnum: number) => number
    public lua_tolstring: (L: LuaState, idx: number, size: number) => string
    public lua_toboolean: (L: LuaState, idx: number) => boolean
    public lua_topointer: (L: LuaState, idx: number) => number
    public lua_tothread: (L: LuaState, idx: number) => number
    public lua_gettable: (L: LuaState, idx: number) => number
    public lua_next: (L: LuaState, idx: number) => boolean
    public lua_type: (L: LuaState, idx: number) => LuaType
    public lua_pushnil: (L: LuaState) => void
    public lua_pushvalue: (L: LuaState, idx: number) => void
    public lua_pushinteger: (L: LuaState, integer: number) => void
    public lua_pushnumber: (L: LuaState, number: number) => void
    public lua_pushstring: (L: LuaState, string: string) => void
    public lua_pushboolean: (L: LuaState, boolean: boolean) => void
    public lua_pushthread: (L: LuaState) => number
    public lua_setglobal: (L: LuaState, name: string) => void
    public lua_setmetatable: (L: LuaState, idx: number) => void
    public lua_createtable: (L: LuaState, narr: number, nrec: number) => void
    public lua_gettop: (L: LuaState) => number
    public lua_settop: (L: LuaState, idx: number) => void
    public lua_settable: (L: LuaState, idx: number) => void
    public lua_callk: (L: LuaState, nargs: number, nresults: number, ctx: number, func: number) => void
    public lua_pcallk: (L: LuaState, nargs: number, nresults: number, msgh: number, ctx: number, func: number) => number
    public lua_pushcclosure: (L: LuaState, cfunction: number, n: number) => void
    public luaL_ref: (L: LuaState, table: number) => number
    public luaL_unref: (L: LuaState, table: number, ref: number) => void
    public lua_rawgeti: (L: LuaState, idx: number, ref: number) => number
    public lua_typename: (L: LuaState, type: LuaType) => number
    public lua_close: (L: LuaState) => void

    private bindWrappedFunctions() {
        this.luaL_newstate = this.module.cwrap('luaL_newstate', 'number', [])
        this.luaL_openlibs = this.module.cwrap('luaL_openlibs', undefined, ['number'])
        this.luaL_loadstring = this.module.cwrap('luaL_loadstring', 'number', ['number', 'string'])
        this.luaL_loadfilex = this.module.cwrap('luaL_loadfilex', 'number', ['number', 'string', 'string'])
        this.lua_getglobal = this.module.cwrap('lua_getglobal', 'number', ['number', 'string'])
        this.lua_tonumberx = this.module.cwrap('lua_tonumberx', 'number', ['number', 'number', 'number'])
        this.lua_tolstring = this.module.cwrap('lua_tolstring', 'string', ['number', 'number', 'number'])
        this.lua_toboolean = this.module.cwrap('lua_toboolean', 'boolean', ['number', 'number'])
        this.lua_topointer = this.module.cwrap('lua_topointer', 'number', ['number', 'number'])
        this.lua_tothread = this.module.cwrap('lua_tothread', 'number', ['number', 'number'])
        this.lua_gettable = this.module.cwrap('lua_gettable', 'number', ['number', 'number'])
        this.lua_next = this.module.cwrap('lua_next', 'boolean', ['number', 'number'])
        this.lua_type = this.module.cwrap('lua_type', 'number', ['number', 'number'])
        this.lua_pushnil = this.module.cwrap('lua_pushnil', undefined, ['number'])
        this.lua_pushvalue = this.module.cwrap('lua_pushvalue', undefined, ['number', 'number'])
        this.lua_pushinteger = this.module.cwrap('lua_pushinteger', undefined, ['number', 'number'])
        this.lua_pushnumber = this.module.cwrap('lua_pushnumber', undefined, ['number', 'number'])
        this.lua_pushstring = this.module.cwrap('lua_pushstring', undefined, ['number', 'string'])
        this.lua_pushboolean = this.module.cwrap('lua_pushboolean', undefined, ['number', 'boolean'])
        this.lua_pushthread = this.module.cwrap('lua_pushthread', 'number', ['number'])
        this.lua_setglobal = this.module.cwrap('lua_setglobal', undefined, ['number', 'string'])
        this.lua_setmetatable = this.module.cwrap('lua_setmetatable', 'number', ['number', 'number'])
        this.lua_createtable = this.module.cwrap('lua_createtable', undefined, ['number', 'number', 'number'])
        this.lua_gettop = this.module.cwrap('lua_gettop', 'number', ['number'])
        this.lua_settop = this.module.cwrap('lua_settop', undefined, ['number', 'number'])
        this.lua_settable = this.module.cwrap('lua_settable', undefined, ['number', 'number'])
        this.lua_callk = this.module.cwrap('lua_callk', undefined, ['number', 'number', 'number', 'number', 'number'])
        this.lua_pcallk = this.module.cwrap('lua_pcallk', 'number', ['number', 'number', 'number', 'number', 'number', 'number'])
        this.lua_pushcclosure = this.module.cwrap('lua_pushcclosure', undefined, ['number', 'number', 'number'])
        this.luaL_ref = this.module.cwrap('luaL_ref', 'number', ['number', 'number'])
        this.luaL_unref = this.module.cwrap('luaL_unref', undefined, ['number', 'number', 'number'])
        this.lua_rawgeti = this.module.cwrap('lua_rawgeti', 'number', ['number', 'number', 'number'])
        this.lua_typename = this.module.cwrap('lua_typename', 'string', ['number', 'number'])
        this.lua_close = this.module.cwrap('lua_close', undefined, ['number'])
    }
}
