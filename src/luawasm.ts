import '../build/glue.wasm'
import { EnvironmentVariables, LUA_REGISTRYINDEX, LuaReturn, LuaState, LuaType } from './types'
import initWasmModule from '../build/glue.js'

interface LuaEmscriptenModule extends EmscriptenModule {
    cwrap: typeof cwrap
    addFunction: typeof addFunction
    removeFunction: typeof removeFunction
    setValue: typeof setValue
    getValue: typeof getValue
    FS: typeof FS
    ENV: EnvironmentVariables
    _realloc: (pointer: number, size: number) => number
}

interface ReferenceMetadata {
    index: number
    refCount: number
}

export default class LuaWasm {
    public static async initialize(customName?: string, env?: EnvironmentVariables): Promise<LuaWasm> {
        const module: LuaEmscriptenModule = await initWasmModule({
            print: console.log,
            printErr: console.error,
            locateFile: (path: string, scriptDirectory: string) => {
                return customName || scriptDirectory + path
            },
            preRun: (initializedModule: LuaEmscriptenModule) => {
                if (typeof env === 'object') {
                    Object.entries(env).forEach(([k, v]) => (initializedModule.ENV[k] = v))
                }
            },
        })
        return new LuaWasm(module)
    }

    public module: LuaEmscriptenModule

    public luaL_checkversion_: (L: LuaState, ver: number, sz: number) => void
    public luaL_getmetafield: (L: LuaState, obj: number, e: string | null) => LuaType
    public luaL_callmeta: (L: LuaState, obj: number, e: string | null) => number
    public luaL_tolstring: (L: LuaState, idx: number, len: number | null) => string
    public luaL_argerror: (L: LuaState, arg: number, extramsg: string | null) => number
    public luaL_typeerror: (L: LuaState, arg: number, tname: string | null) => number
    public luaL_checklstring: (L: LuaState, arg: number, l: number | null) => string
    public luaL_optlstring: (L: LuaState, arg: number, def: string | null, l: number | null) => string
    public luaL_checknumber: (L: LuaState, arg: number) => number
    public luaL_optnumber: (L: LuaState, arg: number, def: number) => number
    public luaL_checkinteger: (L: LuaState, arg: number) => number
    public luaL_optinteger: (L: LuaState, arg: number, def: number) => number
    public luaL_checkstack: (L: LuaState, sz: number, msg: string | null) => void
    public luaL_checktype: (L: LuaState, arg: number, t: number) => void
    public luaL_checkany: (L: LuaState, arg: number) => void
    public luaL_newmetatable: (L: LuaState, tname: string | null) => number
    public luaL_setmetatable: (L: LuaState, tname: string | null) => void
    public luaL_testudata: (L: LuaState, ud: number, tname: string | null) => number
    public luaL_checkudata: (L: LuaState, ud: number, tname: string | null) => number
    public luaL_where: (L: LuaState, lvl: number) => void
    public luaL_fileresult: (L: LuaState, stat: number, fname: string | null) => number
    public luaL_execresult: (L: LuaState, stat: number) => number
    public luaL_ref: (L: LuaState, t: number) => number
    public luaL_unref: (L: LuaState, t: number, ref: number) => void
    public luaL_loadfilex: (L: LuaState, filename: string | null, mode: string | null) => LuaReturn
    public luaL_loadbufferx: (L: LuaState, buff: string | null, sz: number, name: string | null, mode: string | null) => LuaReturn
    public luaL_loadstring: (L: LuaState, s: string | null) => LuaReturn
    public luaL_newstate: () => LuaState
    public luaL_len: (L: LuaState, idx: number) => number
    public luaL_addgsub: (b: number | null, s: string | null, p: string | null, r: string | null) => void
    public luaL_gsub: (L: LuaState, s: string | null, p: string | null, r: string | null) => string
    public luaL_setfuncs: (L: LuaState, l: number | null, nup: number) => void
    public luaL_getsubtable: (L: LuaState, idx: number, fname: string | null) => number
    public luaL_traceback: (L: LuaState, L1: LuaState, msg: string | null, level: number) => void
    public luaL_requiref: (L: LuaState, modname: string | null, openf: number, glb: number) => void
    public luaL_buffinit: (L: LuaState, B: number | null) => void
    public luaL_prepbuffsize: (B: number | null, sz: number) => string
    public luaL_addlstring: (B: number | null, s: string | null, l: number) => void
    public luaL_addstring: (B: number | null, s: string | null) => void
    public luaL_addvalue: (B: number | null) => void
    public luaL_pushresult: (B: number | null) => void
    public luaL_pushresultsize: (B: number | null, sz: number) => void
    public luaL_buffinitsize: (L: LuaState, B: number | null, sz: number) => string
    public lua_newstate: (f: number | null, ud: number | null) => LuaState
    public lua_close: (L: LuaState) => void
    public lua_newthread: (L: LuaState) => LuaState
    public lua_resetthread: (L: LuaState) => LuaReturn
    public lua_atpanic: (L: LuaState, panicf: number) => number
    public lua_version: (L: LuaState) => number
    public lua_absindex: (L: LuaState, idx: number) => number
    public lua_gettop: (L: LuaState) => number
    public lua_settop: (L: LuaState, idx: number) => void
    public lua_pushvalue: (L: LuaState, idx: number) => void
    public lua_rotate: (L: LuaState, idx: number, n: number) => void
    public lua_copy: (L: LuaState, fromidx: number, toidx: number) => void
    public lua_checkstack: (L: LuaState, n: number) => number
    public lua_xmove: (from: LuaState, to: LuaState, n: number) => void
    public lua_isnumber: (L: LuaState, idx: number) => number
    public lua_isstring: (L: LuaState, idx: number) => number
    public lua_iscfunction: (L: LuaState, idx: number) => number
    public lua_isinteger: (L: LuaState, idx: number) => number
    public lua_isuserdata: (L: LuaState, idx: number) => number
    public lua_type: (L: LuaState, idx: number) => LuaType
    public lua_typename: (L: LuaState, tp: number) => string
    public lua_tonumberx: (L: LuaState, idx: number, isnum: number | null) => number
    public lua_tointegerx: (L: LuaState, idx: number, isnum: number | null) => number
    public lua_toboolean: (L: LuaState, idx: number) => number
    public lua_tolstring: (L: LuaState, idx: number, len: number | null) => string
    public lua_rawlen: (L: LuaState, idx: number) => number
    public lua_tocfunction: (L: LuaState, idx: number) => number
    public lua_touserdata: (L: LuaState, idx: number) => number
    public lua_tothread: (L: LuaState, idx: number) => LuaState
    public lua_topointer: (L: LuaState, idx: number) => number
    public lua_arith: (L: LuaState, op: number) => void
    public lua_rawequal: (L: LuaState, idx1: number, idx2: number) => number
    public lua_compare: (L: LuaState, idx1: number, idx2: number, op: number) => number
    public lua_pushnil: (L: LuaState) => void
    public lua_pushnumber: (L: LuaState, n: number) => void
    public lua_pushinteger: (L: LuaState, n: number) => void
    public lua_pushlstring: (L: LuaState, s: string | null, len: number) => string
    public lua_pushstring: (L: LuaState, s: string | null) => string
    public lua_pushcclosure: (L: LuaState, fn: number, n: number) => void
    public lua_pushboolean: (L: LuaState, b: number) => void
    public lua_pushlightuserdata: (L: LuaState, p: number | null) => void
    public lua_pushthread: (L: LuaState) => number
    public lua_getglobal: (L: LuaState, name: string | null) => LuaType
    public lua_gettable: (L: LuaState, idx: number) => LuaType
    public lua_getfield: (L: LuaState, idx: number, k: string | null) => LuaType
    public lua_geti: (L: LuaState, idx: number, n: number) => LuaType
    public lua_rawget: (L: LuaState, idx: number) => number
    public lua_rawgeti: (L: LuaState, idx: number, n: number) => LuaType
    public lua_rawgetp: (L: LuaState, idx: number, p: number | null) => LuaType
    public lua_createtable: (L: LuaState, narr: number, nrec: number) => void
    public lua_newuserdatauv: (L: LuaState, sz: number, nuvalue: number) => number
    public lua_getmetatable: (L: LuaState, objindex: number) => number
    public lua_getiuservalue: (L: LuaState, idx: number, n: number) => LuaType
    public lua_setglobal: (L: LuaState, name: string | null) => void
    public lua_settable: (L: LuaState, idx: number) => void
    public lua_setfield: (L: LuaState, idx: number, k: string | null) => void
    public lua_seti: (L: LuaState, idx: number, n: number) => void
    public lua_rawset: (L: LuaState, idx: number) => void
    public lua_rawseti: (L: LuaState, idx: number, n: number) => void
    public lua_rawsetp: (L: LuaState, idx: number, p: number | null) => void
    public lua_setmetatable: (L: LuaState, objindex: number) => number
    public lua_setiuservalue: (L: LuaState, idx: number, n: number) => number
    public lua_callk: (L: LuaState, nargs: number, nresults: number, ctx: number, k: number | null) => void
    public lua_pcallk: (L: LuaState, nargs: number, nresults: number, errfunc: number, ctx: number, k: number | null) => number
    public lua_load: (L: LuaState, reader: number | null, dt: number | null, chunkname: string | null, mode: string | null) => LuaReturn
    public lua_dump: (L: LuaState, writer: number | null, data: number | null, strip: number) => number
    public lua_yieldk: (L: LuaState, nresults: number, ctx: number, k: number | null) => number
    public lua_resume: (L: LuaState, from: LuaState | null, narg: number, nres: number | null) => LuaReturn
    public lua_status: (L: LuaState) => LuaReturn
    public lua_isyieldable: (L: LuaState) => number
    public lua_setwarnf: (L: LuaState, f: number | null, ud: number | null) => void
    public lua_warning: (L: LuaState, msg: string | null, tocont: number) => void
    public lua_error: (L: LuaState) => number
    public lua_next: (L: LuaState, idx: number) => number
    public lua_concat: (L: LuaState, n: number) => void
    public lua_len: (L: LuaState, idx: number) => void
    public lua_stringtonumber: (L: LuaState, s: string | null) => number
    public lua_getallocf: (L: LuaState, ud: number | null) => number
    public lua_setallocf: (L: LuaState, f: number | null, ud: number | null) => void
    public lua_toclose: (L: LuaState, idx: number) => void
    public lua_closeslot: (L: LuaState, idx: number) => void
    public lua_getstack: (L: LuaState, level: number, ar: number | null) => number
    public lua_getinfo: (L: LuaState, what: string | null, ar: number | null) => number
    public lua_getlocal: (L: LuaState, ar: number | null, n: number) => string
    public lua_setlocal: (L: LuaState, ar: number | null, n: number) => string
    public lua_getupvalue: (L: LuaState, funcindex: number, n: number) => string
    public lua_setupvalue: (L: LuaState, funcindex: number, n: number) => string
    public lua_upvalueid: (L: LuaState, fidx: number, n: number) => number
    public lua_upvaluejoin: (L: LuaState, fidx1: number, n1: number, fidx2: number, n2: number) => void
    public lua_sethook: (L: LuaState, func: number | null, mask: number, count: number) => void
    public lua_gethook: (L: LuaState) => number
    public lua_gethookmask: (L: LuaState) => number
    public lua_gethookcount: (L: LuaState) => number
    public lua_setcstacklimit: (L: LuaState, limit: number) => number
    public luaopen_base: (L: LuaState) => number
    public luaopen_coroutine: (L: LuaState) => number
    public luaopen_table: (L: LuaState) => number
    public luaopen_io: (L: LuaState) => number
    public luaopen_os: (L: LuaState) => number
    public luaopen_string: (L: LuaState) => number
    public luaopen_utf8: (L: LuaState) => number
    public luaopen_math: (L: LuaState) => number
    public luaopen_debug: (L: LuaState) => number
    public luaopen_package: (L: LuaState) => number
    public luaL_openlibs: (L: LuaState) => void

    private referenceTracker = new WeakMap<any, ReferenceMetadata>()
    private referenceMap = new Map<number, any>()
    private availableReferences: number[] = []

    public constructor(module: LuaEmscriptenModule) {
        this.module = module

        this.luaL_checkversion_ = this.module.cwrap('luaL_checkversion_', null, ['number', 'number', 'number'])
        this.luaL_getmetafield = this.module.cwrap('luaL_getmetafield', 'number', ['number', 'number', 'string'])
        this.luaL_callmeta = this.module.cwrap('luaL_callmeta', 'number', ['number', 'number', 'string'])
        this.luaL_tolstring = this.module.cwrap('luaL_tolstring', 'string', ['number', 'number', 'number'])
        this.luaL_argerror = this.module.cwrap('luaL_argerror', 'number', ['number', 'number', 'string'])
        this.luaL_typeerror = this.module.cwrap('luaL_typeerror', 'number', ['number', 'number', 'string'])
        this.luaL_checklstring = this.module.cwrap('luaL_checklstring', 'string', ['number', 'number', 'number'])
        this.luaL_optlstring = this.module.cwrap('luaL_optlstring', 'string', ['number', 'number', 'string', 'number'])
        this.luaL_checknumber = this.module.cwrap('luaL_checknumber', 'number', ['number', 'number'])
        this.luaL_optnumber = this.module.cwrap('luaL_optnumber', 'number', ['number', 'number', 'number'])
        this.luaL_checkinteger = this.module.cwrap('luaL_checkinteger', 'number', ['number', 'number'])
        this.luaL_optinteger = this.module.cwrap('luaL_optinteger', 'number', ['number', 'number', 'number'])
        this.luaL_checkstack = this.module.cwrap('luaL_checkstack', null, ['number', 'number', 'string'])
        this.luaL_checktype = this.module.cwrap('luaL_checktype', null, ['number', 'number', 'number'])
        this.luaL_checkany = this.module.cwrap('luaL_checkany', null, ['number', 'number'])
        this.luaL_newmetatable = this.module.cwrap('luaL_newmetatable', 'number', ['number', 'string'])
        this.luaL_setmetatable = this.module.cwrap('luaL_setmetatable', null, ['number', 'string'])
        this.luaL_testudata = this.module.cwrap('luaL_testudata', 'number', ['number', 'number', 'string'])
        this.luaL_checkudata = this.module.cwrap('luaL_checkudata', 'number', ['number', 'number', 'string'])
        this.luaL_where = this.module.cwrap('luaL_where', null, ['number', 'number'])
        this.luaL_fileresult = this.module.cwrap('luaL_fileresult', 'number', ['number', 'number', 'string'])
        this.luaL_execresult = this.module.cwrap('luaL_execresult', 'number', ['number', 'number'])
        this.luaL_ref = this.module.cwrap('luaL_ref', 'number', ['number', 'number'])
        this.luaL_unref = this.module.cwrap('luaL_unref', null, ['number', 'number', 'number'])
        this.luaL_loadfilex = this.module.cwrap('luaL_loadfilex', 'number', ['number', 'string', 'string'])
        this.luaL_loadbufferx = this.module.cwrap('luaL_loadbufferx', 'number', ['number', 'string', 'number', 'string', 'string'])
        this.luaL_loadstring = this.module.cwrap('luaL_loadstring', 'number', ['number', 'string'])
        this.luaL_newstate = this.module.cwrap('luaL_newstate', 'number', [])
        this.luaL_len = this.module.cwrap('luaL_len', 'number', ['number', 'number'])
        this.luaL_addgsub = this.module.cwrap('luaL_addgsub', null, ['number', 'string', 'string', 'string'])
        this.luaL_gsub = this.module.cwrap('luaL_gsub', 'string', ['number', 'string', 'string', 'string'])
        this.luaL_setfuncs = this.module.cwrap('luaL_setfuncs', null, ['number', 'number', 'number'])
        this.luaL_getsubtable = this.module.cwrap('luaL_getsubtable', 'number', ['number', 'number', 'string'])
        this.luaL_traceback = this.module.cwrap('luaL_traceback', null, ['number', 'number', 'string', 'number'])
        this.luaL_requiref = this.module.cwrap('luaL_requiref', null, ['number', 'string', 'number', 'number'])
        this.luaL_buffinit = this.module.cwrap('luaL_buffinit', null, ['number', 'number'])
        this.luaL_prepbuffsize = this.module.cwrap('luaL_prepbuffsize', 'string', ['number', 'number'])
        this.luaL_addlstring = this.module.cwrap('luaL_addlstring', null, ['number', 'string', 'number'])
        this.luaL_addstring = this.module.cwrap('luaL_addstring', null, ['number', 'string'])
        this.luaL_addvalue = this.module.cwrap('luaL_addvalue', null, ['number'])
        this.luaL_pushresult = this.module.cwrap('luaL_pushresult', null, ['number'])
        this.luaL_pushresultsize = this.module.cwrap('luaL_pushresultsize', null, ['number', 'number'])
        this.luaL_buffinitsize = this.module.cwrap('luaL_buffinitsize', 'string', ['number', 'number', 'number'])
        this.lua_newstate = this.module.cwrap('lua_newstate', 'number', ['number', 'number'])
        this.lua_close = this.module.cwrap('lua_close', null, ['number'])
        this.lua_newthread = this.module.cwrap('lua_newthread', 'number', ['number'])
        this.lua_resetthread = this.module.cwrap('lua_resetthread', 'number', ['number'])
        this.lua_atpanic = this.module.cwrap('lua_atpanic', 'number', ['number', 'number'])
        this.lua_version = this.module.cwrap('lua_version', 'number', ['number'])
        this.lua_absindex = this.module.cwrap('lua_absindex', 'number', ['number', 'number'])
        this.lua_gettop = this.module.cwrap('lua_gettop', 'number', ['number'])
        this.lua_settop = this.module.cwrap('lua_settop', null, ['number', 'number'])
        this.lua_pushvalue = this.module.cwrap('lua_pushvalue', null, ['number', 'number'])
        this.lua_rotate = this.module.cwrap('lua_rotate', null, ['number', 'number', 'number'])
        this.lua_copy = this.module.cwrap('lua_copy', null, ['number', 'number', 'number'])
        this.lua_checkstack = this.module.cwrap('lua_checkstack', 'number', ['number', 'number'])
        this.lua_xmove = this.module.cwrap('lua_xmove', null, ['number', 'number', 'number'])
        this.lua_isnumber = this.module.cwrap('lua_isnumber', 'number', ['number', 'number'])
        this.lua_isstring = this.module.cwrap('lua_isstring', 'number', ['number', 'number'])
        this.lua_iscfunction = this.module.cwrap('lua_iscfunction', 'number', ['number', 'number'])
        this.lua_isinteger = this.module.cwrap('lua_isinteger', 'number', ['number', 'number'])
        this.lua_isuserdata = this.module.cwrap('lua_isuserdata', 'number', ['number', 'number'])
        this.lua_type = this.module.cwrap('lua_type', 'number', ['number', 'number'])
        this.lua_typename = this.module.cwrap('lua_typename', 'string', ['number', 'number'])
        this.lua_tonumberx = this.module.cwrap('lua_tonumberx', 'number', ['number', 'number', 'number'])
        this.lua_tointegerx = this.module.cwrap('lua_tointegerx', 'number', ['number', 'number', 'number'])
        this.lua_toboolean = this.module.cwrap('lua_toboolean', 'number', ['number', 'number'])
        this.lua_tolstring = this.module.cwrap('lua_tolstring', 'string', ['number', 'number', 'number'])
        this.lua_rawlen = this.module.cwrap('lua_rawlen', 'number', ['number', 'number'])
        this.lua_tocfunction = this.module.cwrap('lua_tocfunction', 'number', ['number', 'number'])
        this.lua_touserdata = this.module.cwrap('lua_touserdata', 'number', ['number', 'number'])
        this.lua_tothread = this.module.cwrap('lua_tothread', 'number', ['number', 'number'])
        this.lua_topointer = this.module.cwrap('lua_topointer', 'number', ['number', 'number'])
        this.lua_arith = this.module.cwrap('lua_arith', null, ['number', 'number'])
        this.lua_rawequal = this.module.cwrap('lua_rawequal', 'number', ['number', 'number', 'number'])
        this.lua_compare = this.module.cwrap('lua_compare', 'number', ['number', 'number', 'number', 'number'])
        this.lua_pushnil = this.module.cwrap('lua_pushnil', null, ['number'])
        this.lua_pushnumber = this.module.cwrap('lua_pushnumber', null, ['number', 'number'])
        this.lua_pushinteger = this.module.cwrap('lua_pushinteger', null, ['number', 'number'])
        this.lua_pushlstring = this.module.cwrap('lua_pushlstring', 'string', ['number', 'string', 'number'])
        this.lua_pushstring = this.module.cwrap('lua_pushstring', 'string', ['number', 'string'])
        this.lua_pushcclosure = this.module.cwrap('lua_pushcclosure', null, ['number', 'number', 'number'])
        this.lua_pushboolean = this.module.cwrap('lua_pushboolean', null, ['number', 'number'])
        this.lua_pushlightuserdata = this.module.cwrap('lua_pushlightuserdata', null, ['number', 'number'])
        this.lua_pushthread = this.module.cwrap('lua_pushthread', 'number', ['number'])
        this.lua_getglobal = this.module.cwrap('lua_getglobal', 'number', ['number', 'string'])
        this.lua_gettable = this.module.cwrap('lua_gettable', 'number', ['number', 'number'])
        this.lua_getfield = this.module.cwrap('lua_getfield', 'number', ['number', 'number', 'string'])
        this.lua_geti = this.module.cwrap('lua_geti', 'number', ['number', 'number', 'number'])
        this.lua_rawget = this.module.cwrap('lua_rawget', 'number', ['number', 'number'])
        this.lua_rawgeti = this.module.cwrap('lua_rawgeti', 'number', ['number', 'number', 'number'])
        this.lua_rawgetp = this.module.cwrap('lua_rawgetp', 'number', ['number', 'number', 'number'])
        this.lua_createtable = this.module.cwrap('lua_createtable', null, ['number', 'number', 'number'])
        this.lua_newuserdatauv = this.module.cwrap('lua_newuserdatauv', 'number', ['number', 'number', 'number'])
        this.lua_getmetatable = this.module.cwrap('lua_getmetatable', 'number', ['number', 'number'])
        this.lua_getiuservalue = this.module.cwrap('lua_getiuservalue', 'number', ['number', 'number', 'number'])
        this.lua_setglobal = this.module.cwrap('lua_setglobal', null, ['number', 'string'])
        this.lua_settable = this.module.cwrap('lua_settable', null, ['number', 'number'])
        this.lua_setfield = this.module.cwrap('lua_setfield', null, ['number', 'number', 'string'])
        this.lua_seti = this.module.cwrap('lua_seti', null, ['number', 'number', 'number'])
        this.lua_rawset = this.module.cwrap('lua_rawset', null, ['number', 'number'])
        this.lua_rawseti = this.module.cwrap('lua_rawseti', null, ['number', 'number', 'number'])
        this.lua_rawsetp = this.module.cwrap('lua_rawsetp', null, ['number', 'number', 'number'])
        this.lua_setmetatable = this.module.cwrap('lua_setmetatable', 'number', ['number', 'number'])
        this.lua_setiuservalue = this.module.cwrap('lua_setiuservalue', 'number', ['number', 'number', 'number'])
        this.lua_callk = this.module.cwrap('lua_callk', null, ['number', 'number', 'number', 'number', 'number'])
        this.lua_pcallk = this.module.cwrap('lua_pcallk', 'number', ['number', 'number', 'number', 'number', 'number', 'number'])
        this.lua_load = this.module.cwrap('lua_load', 'number', ['number', 'number', 'number', 'string', 'string'])
        this.lua_dump = this.module.cwrap('lua_dump', 'number', ['number', 'number', 'number', 'number'])
        this.lua_yieldk = this.module.cwrap('lua_yieldk', 'number', ['number', 'number', 'number', 'number'])
        this.lua_resume = this.module.cwrap('lua_resume', 'number', ['number', 'number', 'number', 'number'])
        this.lua_status = this.module.cwrap('lua_status', 'number', ['number'])
        this.lua_isyieldable = this.module.cwrap('lua_isyieldable', 'number', ['number'])
        this.lua_setwarnf = this.module.cwrap('lua_setwarnf', null, ['number', 'number', 'number'])
        this.lua_warning = this.module.cwrap('lua_warning', null, ['number', 'string', 'number'])
        this.lua_error = this.module.cwrap('lua_error', 'number', ['number'])
        this.lua_next = this.module.cwrap('lua_next', 'number', ['number', 'number'])
        this.lua_concat = this.module.cwrap('lua_concat', null, ['number', 'number'])
        this.lua_len = this.module.cwrap('lua_len', null, ['number', 'number'])
        this.lua_stringtonumber = this.module.cwrap('lua_stringtonumber', 'number', ['number', 'string'])
        this.lua_getallocf = this.module.cwrap('lua_getallocf', 'number', ['number', 'number'])
        this.lua_setallocf = this.module.cwrap('lua_setallocf', null, ['number', 'number', 'number'])
        this.lua_toclose = this.module.cwrap('lua_toclose', null, ['number', 'number'])
        this.lua_closeslot = this.module.cwrap('lua_closeslot', null, ['number', 'number'])
        this.lua_getstack = this.module.cwrap('lua_getstack', 'number', ['number', 'number', 'number'])
        this.lua_getinfo = this.module.cwrap('lua_getinfo', 'number', ['number', 'string', 'number'])
        this.lua_getlocal = this.module.cwrap('lua_getlocal', 'string', ['number', 'number', 'number'])
        this.lua_setlocal = this.module.cwrap('lua_setlocal', 'string', ['number', 'number', 'number'])
        this.lua_getupvalue = this.module.cwrap('lua_getupvalue', 'string', ['number', 'number', 'number'])
        this.lua_setupvalue = this.module.cwrap('lua_setupvalue', 'string', ['number', 'number', 'number'])
        this.lua_upvalueid = this.module.cwrap('lua_upvalueid', 'number', ['number', 'number', 'number'])
        this.lua_upvaluejoin = this.module.cwrap('lua_upvaluejoin', null, ['number', 'number', 'number', 'number', 'number'])
        this.lua_sethook = this.module.cwrap('lua_sethook', null, ['number', 'number', 'number', 'number'])
        this.lua_gethook = this.module.cwrap('lua_gethook', 'number', ['number'])
        this.lua_gethookmask = this.module.cwrap('lua_gethookmask', 'number', ['number'])
        this.lua_gethookcount = this.module.cwrap('lua_gethookcount', 'number', ['number'])
        this.lua_setcstacklimit = this.module.cwrap('lua_setcstacklimit', 'number', ['number', 'number'])
        this.luaopen_base = this.module.cwrap('luaopen_base', 'number', ['number'])
        this.luaopen_coroutine = this.module.cwrap('luaopen_coroutine', 'number', ['number'])
        this.luaopen_table = this.module.cwrap('luaopen_table', 'number', ['number'])
        this.luaopen_io = this.module.cwrap('luaopen_io', 'number', ['number'])
        this.luaopen_os = this.module.cwrap('luaopen_os', 'number', ['number'])
        this.luaopen_string = this.module.cwrap('luaopen_string', 'number', ['number'])
        this.luaopen_utf8 = this.module.cwrap('luaopen_utf8', 'number', ['number'])
        this.luaopen_math = this.module.cwrap('luaopen_math', 'number', ['number'])
        this.luaopen_debug = this.module.cwrap('luaopen_debug', 'number', ['number'])
        this.luaopen_package = this.module.cwrap('luaopen_package', 'number', ['number'])
        this.luaL_openlibs = this.module.cwrap('luaL_openlibs', null, ['number'])
    }

    public lua_remove(luaState: LuaState, index: number): void {
        this.lua_rotate(luaState, index, -1)
        this.lua_pop(luaState, 1)
    }

    public lua_pop(luaState: LuaState, count: number): void {
        this.lua_settop(luaState, -count - 1)
    }

    public luaL_getmetatable(luaState: LuaState, name: string): LuaType {
        return this.lua_getfield(luaState, LUA_REGISTRYINDEX, name)
    }

    public lua_yield(luaState: LuaState, count: number): number {
        return this.lua_yieldk(luaState, count, 0, null)
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
