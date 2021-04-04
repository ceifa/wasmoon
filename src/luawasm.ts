import '../build/glue.wasm'
import { LUA_REGISTRYINDEX, LuaResumeResult, LuaReturn, LuaState, LuaType, PointerSize } from './types'
import initWasmModule from '../build/glue.js'

interface LuaEmscriptenModule extends EmscriptenModule {
    cwrap: typeof cwrap
    addFunction: typeof addFunction
    removeFunction: typeof removeFunction
    setValue: typeof setValue
    getValue: typeof getValue
    FS: typeof FS
    _realloc: (pointer: number, size: number) => number
}

interface ReferenceMetadata {
    index: number
    refCount: number
}

export default class LuaWasm {
    public static async initialize(customName?: string): Promise<LuaWasm> {
        const module: LuaEmscriptenModule = await initWasmModule({
            print: console.log,
            printErr: console.error,
            locateFile: (path: string, scriptDirectory: string) => {
                return customName || scriptDirectory + path
            },
        })
        return new LuaWasm(module)
    }

    public module: LuaEmscriptenModule

    public luaL_newstate: () => LuaState
    public lua_newstate: (allocatorFunction: number, userData: number | null) => LuaState
    public luaL_openlibs: (L: LuaState) => void
    public luaL_loadstring: (L: LuaState, code: string) => LuaReturn
    public luaL_loadfilex: (L: LuaState, filename: string, mode?: string) => LuaReturn
    public lua_getglobal: (L: LuaState, name: string) => LuaType
    public lua_tonumberx: (L: LuaState, idx: number, isnum?: number) => number
    public lua_tolstring: (L: LuaState, idx: number, size?: number) => string
    public lua_toboolean: (L: LuaState, idx: number) => boolean
    public lua_topointer: (L: LuaState, idx: number) => number
    public lua_tothread: (L: LuaState, idx: number) => number
    public lua_newthread: (L: LuaState) => number
    public lua_resetthread: (L: LuaState) => LuaReturn
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
    public lua_callk: (L: LuaState, nargs: number, nresults: number, ctx: number, func?: number) => void
    public lua_pcallk: (L: LuaState, nargs: number, nresults: number, msgh: number, ctx: number, func?: number) => number
    public lua_yieldk: (L: LuaState, nresults: number, context: number, continuance: number | undefined) => LuaReturn
    public lua_status: (L: LuaState) => LuaReturn
    public lua_resume: (L: LuaState, fromState: LuaState | undefined, argCount: number) => LuaResumeResult
    public lua_pushcclosure: (L: LuaState, cfunction: number, n: number) => void
    public luaL_newmetatable: (L: LuaState, name: string) => boolean
    public lua_getfield: (L: LuaState, index: number, name: string) => LuaType
    public lua_newuserdatauv: (L: LuaState, size: number, nuvalue: number) => number // pointer
    public luaL_checkudata: (L: LuaState, arg: number, name: string) => number // pointer
    public luaL_testudata: (L: LuaState, arg: number, name: string) => number | undefined | null // pointer
    public luaL_ref: (L: LuaState, table: number) => number
    public luaL_unref: (L: LuaState, table: number, ref: number) => void
    public lua_rawgeti: (L: LuaState, idx: number, ref: number) => number
    public lua_typename: (L: LuaState, type: LuaType) => number
    public lua_close: (L: LuaState) => void

    private referenceTracker = new WeakMap<any, ReferenceMetadata>()
    private referenceMap = new Map<number, any>()
    private availableReferences: number[] = []

    public constructor(module: LuaEmscriptenModule) {
        this.module = module

        this.luaL_newstate = this.module.cwrap('luaL_newstate', 'number', [])
        this.lua_newstate = this.module.cwrap('lua_newstate', 'number', ['number', 'number'])
        this.luaL_openlibs = this.module.cwrap('luaL_openlibs', null, ['number'])
        this.luaL_loadstring = this.module.cwrap('luaL_loadstring', 'number', ['number', 'string'])
        this.luaL_loadfilex = this.module.cwrap('luaL_loadfilex', 'number', ['number', 'string', 'string'])
        this.lua_getglobal = this.module.cwrap('lua_getglobal', 'number', ['number', 'string'])
        this.lua_tonumberx = this.module.cwrap('lua_tonumberx', 'number', ['number', 'number', 'number'])
        this.lua_tolstring = this.module.cwrap('lua_tolstring', 'string', ['number', 'number', 'number'])
        this.lua_toboolean = this.module.cwrap('lua_toboolean', 'boolean', ['number', 'number'])
        this.lua_topointer = this.module.cwrap('lua_topointer', 'number', ['number', 'number'])
        this.lua_tothread = this.module.cwrap('lua_tothread', 'number', ['number', 'number'])
        this.lua_newthread = this.module.cwrap('lua_newthread', 'number', ['number'])
        this.lua_resetthread = this.module.cwrap('lua_resetthread', 'number', ['number'])
        this.lua_gettable = this.module.cwrap('lua_gettable', 'number', ['number', 'number'])
        this.lua_next = this.module.cwrap('lua_next', 'boolean', ['number', 'number'])
        this.lua_type = this.module.cwrap('lua_type', 'number', ['number', 'number'])
        this.lua_pushnil = this.module.cwrap('lua_pushnil', null, ['number'])
        this.lua_pushvalue = this.module.cwrap('lua_pushvalue', null, ['number', 'number'])
        this.lua_pushinteger = this.module.cwrap('lua_pushinteger', null, ['number', 'number'])
        this.lua_pushnumber = this.module.cwrap('lua_pushnumber', null, ['number', 'number'])
        this.lua_pushstring = this.module.cwrap('lua_pushstring', null, ['number', 'string'])
        this.lua_pushboolean = this.module.cwrap('lua_pushboolean', null, ['number', 'boolean'])
        this.lua_pushthread = this.module.cwrap('lua_pushthread', 'number', ['number'])
        this.lua_setglobal = this.module.cwrap('lua_setglobal', null, ['number', 'string'])
        this.lua_setmetatable = this.module.cwrap('lua_setmetatable', 'number', ['number', 'number'])
        this.lua_createtable = this.module.cwrap('lua_createtable', null, ['number', 'number', 'number'])
        this.lua_gettop = this.module.cwrap('lua_gettop', 'number', ['number'])
        this.lua_settop = this.module.cwrap('lua_settop', null, ['number', 'number'])
        this.lua_settable = this.module.cwrap('lua_settable', null, ['number', 'number'])
        this.lua_callk = this.module.cwrap('lua_callk', null, ['number', 'number', 'number', 'number', 'number'])
        this.lua_pcallk = this.module.cwrap('lua_pcallk', 'number', ['number', 'number', 'number', 'number', 'number', 'number'])
        this.lua_yieldk = this.module.cwrap('lua_yieldk', 'number', ['number', 'number', 'number', 'number'])
        this.lua_status = this.module.cwrap('lua_status', 'number', ['number'])

        const lua_resume_raw = this.module.cwrap('lua_resume', 'number', ['number', 'number', 'number', 'number'])
        this.lua_resume = (luaState, fromState, argCount) => {
            const dataPointer = this.module._malloc(PointerSize)
            try {
                this.module.setValue(dataPointer, 0, 'i32')
                const luaResult = lua_resume_raw(luaState, fromState, argCount, dataPointer)
                return {
                    result: luaResult,
                    resultCount: this.module.getValue(dataPointer, 'i32'),
                }
            } finally {
                this.module._free(dataPointer)
            }
        }

        this.lua_pushcclosure = this.module.cwrap('lua_pushcclosure', null, ['number', 'number', 'number'])
        this.luaL_newmetatable = this.module.cwrap('luaL_newmetatable', 'boolean', ['number', 'string'])
        this.lua_getfield = this.module.cwrap('lua_getfield', 'number', ['number', 'number', 'string'])
        this.lua_newuserdatauv = this.module.cwrap('lua_newuserdatauv', 'number', ['number', 'number', 'number'])
        this.luaL_checkudata = this.module.cwrap('luaL_checkudata', 'number', ['number', 'number', 'string'])
        this.luaL_testudata = this.module.cwrap('luaL_testudata', 'number', ['number', 'number', 'string'])
        this.luaL_ref = this.module.cwrap('luaL_ref', 'number', ['number', 'number'])
        this.luaL_unref = this.module.cwrap('luaL_unref', null, ['number', 'number', 'number'])
        this.lua_rawgeti = this.module.cwrap('lua_rawgeti', 'number', ['number', 'number', 'number'])
        this.lua_typename = this.module.cwrap('lua_typename', 'string', ['number', 'number'])
        this.lua_close = this.module.cwrap('lua_close', null, ['number'])
    }

    public lua_pop(luaState: LuaState, count: number): void {
        this.lua_settop(luaState, -count - 1)
    }

    public luaL_getmetatable(luaState: LuaState, name: string): LuaType {
        return this.lua_getfield(luaState, LUA_REGISTRYINDEX, name)
    }

    public ref(data: any): number {
        const existing = this.referenceTracker.get(data)
        if (existing) {
            existing.refCount++
            return existing.index
        }

        const availableIndex = this.availableReferences.pop()
        // +1 so the index is always truthy and not a "nullptr".
        const index = availableIndex === undefined ? this.referenceMap.size + 1 : availableIndex
        this.referenceMap.set(index, data)
        this.referenceTracker.set(data, {
            refCount: 1,
            index,
        })

        return index
    }

    public unref(index: number): void {
        const ref = this.referenceMap.get(index)
        if (ref === undefined) {
            return
        }
        const metadata = this.referenceTracker.get(ref)
        if (metadata === undefined) {
            this.referenceTracker.delete(ref)
            this.availableReferences.push(index)
            return
        }

        metadata.refCount--
        if (metadata.refCount <= 0) {
            this.referenceTracker.delete(ref)
            this.referenceMap.delete(index)
            this.availableReferences.push(index)
        }
    }

    public getRef(index: number): any | undefined {
        return this.referenceMap.get(index)
    }
}
