import initWasmModule from '../build/glue.js'
import { LUA_REGISTRYINDEX, LuaReturn, LuaState, LuaType } from './types.js'
// A rolldown plugin will resolve this to the current version on package.json
import version from 'package-version'

type EnvironmentVariables = Record<string, string | undefined>

interface LuaEmscriptenModule extends EmscriptenModule {
    ccall: typeof ccall
    addFunction: typeof addFunction
    removeFunction: typeof removeFunction
    setValue: typeof setValue
    getValue: typeof getValue
    FS: {
        filesystems: {
            NODEFS: Emscripten.FileSystemType
            MEMFS: Emscripten.FileSystemType
        }
        mkdirTree: (path: string) => void
        mount: (type: Emscripten.FileSystemType, opts: { root: string }, mountpoint: string) => void
        chdir: (path: string) => void
        init: (
            input: (() => number | null) | null,
            output: ((charCode: number | null) => void) | null,
            error: ((charCode: number | null) => void) | null,
        ) => void
        writeFile: (path: string, content: string | ArrayBufferView) => void
    }
    PATH: {
        dirname: (path: string) => string
    }
    stringToNewUTF8: typeof allocateUTF8
    lengthBytesUTF8: typeof lengthBytesUTF8
    stringToUTF8: typeof stringToUTF8
    intArrayFromString: typeof intArrayFromString
    UTF8ToString: typeof UTF8ToString
    ENV: EnvironmentVariables
    _realloc: (pointer: number, size: number) => number
}

interface ReferenceMetadata {
    index: number
    refCount: number
}

export default class LuaModule {
    public static async initialize(opts: {
        wasmFile?: string
        env?: EnvironmentVariables
        fs?: 'node' | 'memory'
        stdin?: () => string
        stdout?: (content: string) => void
        stderr?: (content: string) => void
    }): Promise<LuaModule> {
        const isBrowser =
            (typeof window === 'object' && typeof window.document !== 'undefined') ||
            (typeof self === 'object' && self?.constructor?.name === 'DedicatedWorkerGlobalScope')

        if (opts.wasmFile === undefined && isBrowser) {
            opts.wasmFile = `https://unpkg.com/wasmoon@${version}/dist/glue.wasm`
        }

        const fs = !isBrowser && opts.fs === 'node' && typeof process !== 'undefined' ? await import('node:fs') : null
        const child_process = !isBrowser && opts.fs === 'node' && typeof process !== 'undefined' ? await import('node:child_process') : null

        const module: LuaEmscriptenModule = await initWasmModule({
            locateFile: (path: string, scriptDirectory: string) => {
                return opts.wasmFile || scriptDirectory + path
            },
            preRun: (initializedModule: LuaEmscriptenModule) => {
                if (typeof opts?.env === 'object') {
                    Object.assign(initializedModule.ENV, opts.env)
                }

                if (fs && child_process) {
                    let rootdirs: string[]
                    if (process.platform === 'win32') {
                        const stdout = child_process.execSync('wmic logicaldisk get name', {
                            encoding: 'utf8',
                        })
                        const drives = stdout
                            .split('\n')
                            .map((line) => line.trim())
                            .filter((line) => line && line !== 'Name')
                            .map((line) => `${line}\\`)

                        rootdirs = []
                        for (const drive of drives) {
                            rootdirs.push(
                                ...fs
                                    .readdirSync(drive)
                                    .filter((dir) => !['dev', 'lib', 'proc'].includes(dir))
                                    .map((dir) => `${drive}${dir}`.replace(/\\|\\\\/g, '/')),
                            )
                        }
                    } else {
                        rootdirs = fs
                            .readdirSync('/')
                            .filter((dir) => !['dev', 'lib', 'proc'].includes(dir))
                            .map((dir) => `/${dir}`)
                    }

                    for (const dir of rootdirs) {
                        try {
                            const moduleFS = initializedModule.FS
                            moduleFS.mkdirTree(dir)
                            moduleFS.mount(moduleFS.filesystems.NODEFS, { root: dir }, dir)
                        } catch {
                            // silently fail to mount (generally due to EPERM)
                        }
                    }

                    initializedModule.FS.chdir(process.cwd().replace(/\\|\\\\/g, '/'))
                }

                if (opts.stdin || opts.stdout || opts.stderr) {
                    let bufferedInput: number[] | undefined
                    initializedModule.FS.init(
                        opts.stdin
                            ? () => {
                                  if (!bufferedInput) {
                                      const input = opts.stdin?.()
                                      if (typeof input === 'string') {
                                          bufferedInput = initializedModule.intArrayFromString(input, true).concat([0])
                                      } else {
                                          throw new Error('stdin must return a string')
                                      }
                                  }

                                  if (bufferedInput.length === 0) {
                                      bufferedInput = undefined
                                      return null
                                  }

                                  const item = bufferedInput.shift()
                                  return !item || item === 0 ? null : item
                              }
                            : null,
                        createOutputWriter(opts.stdout),
                        createOutputWriter(opts.stderr),
                    )
                }
            },
        })
        return new LuaModule(module)
    }

    public _emscripten: LuaEmscriptenModule

    public luaL_checkversion_: (a: LuaState, b: number, c: number) => void
    public luaL_getmetafield: (a: LuaState, b: number, c: string | null) => LuaType
    public luaL_callmeta: (a: LuaState, b: number, c: string | null) => number
    public luaL_tolstring: (a: LuaState, b: number, c: number | null) => string
    public luaL_argerror: (a: LuaState, b: number, c: string | null) => number
    public luaL_typeerror: (a: LuaState, b: number, c: string | null) => number
    public luaL_checklstring: (a: LuaState, b: number, c: number | null) => string
    public luaL_optlstring: (a: LuaState, b: number, c: string | null, d: number | null) => string
    public luaL_checknumber: (a: LuaState, b: number) => number
    public luaL_optnumber: (a: LuaState, b: number, c: number) => number
    public luaL_checkinteger: (a: LuaState, b: number) => number
    public luaL_optinteger: (a: LuaState, b: number, c: number) => number
    public luaL_checkstack: (a: LuaState, b: number, c: string | null) => void
    public luaL_checktype: (a: LuaState, b: number, c: number) => void
    public luaL_checkany: (a: LuaState, b: number) => void
    public luaL_newmetatable: (a: LuaState, b: string | null) => number
    public luaL_setmetatable: (a: LuaState, b: string | null) => void
    public luaL_testudata: (a: LuaState, b: number, c: string | null) => number
    public luaL_checkudata: (a: LuaState, b: number, c: string | null) => number
    public luaL_where: (a: LuaState, b: number) => void
    public luaL_fileresult: (a: LuaState, b: number, c: string | null) => number
    public luaL_execresult: (a: LuaState, b: number) => number
    public luaL_ref: (a: LuaState, b: number) => number
    public luaL_unref: (a: LuaState, b: number, c: number) => void
    public luaL_loadfilex: (a: LuaState, b: string | null, c: string | null) => LuaReturn
    public luaL_loadbufferx: (
        L: LuaState,
        buff: string | number | null,
        sz: number,
        name: string | number | null,
        mode: string | null,
    ) => LuaReturn
    public luaL_loadstring: (a: LuaState, b: string | null) => LuaReturn
    public luaL_newstate: () => LuaState
    public luaL_len: (a: LuaState, b: number) => number
    public luaL_addgsub: (a: number | null, b: string | null, c: string | null, d: string | null) => void
    public luaL_gsub: (a: LuaState, b: string | null, c: string | null, d: string | null) => string
    public luaL_setfuncs: (a: LuaState, b: number | null, c: number) => void
    public luaL_getsubtable: (a: LuaState, b: number, c: string | null) => number
    public luaL_traceback: (a: LuaState, b: LuaState, c: string | null, d: number) => void
    public luaL_requiref: (a: LuaState, b: string | null, c: number, d: number) => void
    public luaL_openselectedlibs: (a: LuaState, b: number, c: number) => void
    public luaL_buffinit: (a: LuaState, b: number | null) => void
    public luaL_prepbuffsize: (a: number | null, b: number) => string
    public luaL_addlstring: (a: number | null, b: string | null, c: number) => void
    public luaL_addstring: (a: number | null, b: string | null) => void
    public luaL_addvalue: (a: number | null) => void
    public luaL_pushresult: (a: number | null) => void
    public luaL_pushresultsize: (a: number | null, b: number) => void
    public luaL_buffinitsize: (a: LuaState, b: number | null, c: number) => string
    public lua_newstate: (a: number | null, b: number | null, c: number) => LuaState
    public lua_close: (a: LuaState) => void
    public lua_newthread: (a: LuaState) => LuaState
    public lua_closethread: (a: LuaState, b: LuaState | null) => LuaReturn
    public lua_resetthread: (a: LuaState) => LuaReturn
    public lua_atpanic: (a: LuaState, b: number) => number
    public lua_version: (a: LuaState) => number
    public lua_absindex: (a: LuaState, b: number) => number
    public lua_gettop: (a: LuaState) => number
    public lua_settop: (a: LuaState, b: number) => void
    public lua_pushvalue: (a: LuaState, b: number) => void
    public lua_rotate: (a: LuaState, b: number, c: number) => void
    public lua_copy: (a: LuaState, b: number, c: number) => void
    public lua_checkstack: (a: LuaState, b: number) => number
    public lua_xmove: (a: LuaState, b: LuaState, c: number) => void
    public lua_isnumber: (a: LuaState, b: number) => number
    public lua_isstring: (a: LuaState, b: number) => number
    public lua_iscfunction: (a: LuaState, b: number) => number
    public lua_isinteger: (a: LuaState, b: number) => number
    public lua_isuserdata: (a: LuaState, b: number) => number
    public lua_type: (a: LuaState, b: number) => LuaType
    public lua_typename: (a: LuaState, b: number) => string
    public lua_tonumberx: (a: LuaState, b: number, c: number | null) => number
    public lua_tointegerx: (a: LuaState, b: number, c: number | null) => bigint
    public lua_toboolean: (a: LuaState, b: number) => number
    public lua_tolstring: (a: LuaState, b: number, c: number | null) => string
    public lua_rawlen: (a: LuaState, b: number) => bigint
    public lua_tocfunction: (a: LuaState, b: number) => number
    public lua_touserdata: (a: LuaState, b: number) => number
    public lua_tothread: (a: LuaState, b: number) => LuaState
    public lua_topointer: (a: LuaState, b: number) => number
    public lua_arith: (a: LuaState, b: number) => void
    public lua_rawequal: (a: LuaState, b: number, c: number) => number
    public lua_compare: (a: LuaState, b: number, c: number, d: number) => number
    public lua_pushnil: (a: LuaState) => void
    public lua_pushnumber: (a: LuaState, b: number) => void
    public lua_pushinteger: (a: LuaState, b: bigint) => void
    public lua_pushlstring: (a: LuaState, b: string | number | null, c: number) => string
    public lua_pushstring: (a: LuaState, b: string | number | null) => string
    public lua_pushcclosure: (a: LuaState, b: number, c: number) => void
    public lua_pushboolean: (a: LuaState, b: number) => void
    public lua_pushlightuserdata: (a: LuaState, b: number | null) => void
    public lua_pushthread: (a: LuaState) => number
    public lua_getglobal: (a: LuaState, b: string | null) => LuaType
    public lua_gettable: (a: LuaState, b: number) => LuaType
    public lua_getfield: (a: LuaState, b: number, c: string | null) => LuaType
    public lua_geti: (a: LuaState, b: number, c: bigint) => LuaType
    public lua_rawget: (a: LuaState, b: number) => number
    public lua_rawgeti: (a: LuaState, b: number, c: bigint) => LuaType
    public lua_rawgetp: (a: LuaState, b: number, c: number | null) => LuaType
    public lua_createtable: (a: LuaState, b: number, c: number) => void
    public lua_newuserdatauv: (a: LuaState, b: number, c: number) => number
    public lua_getmetatable: (a: LuaState, b: number) => number
    public lua_getiuservalue: (a: LuaState, b: number, c: number) => LuaType
    public lua_setglobal: (a: LuaState, b: string | null) => void
    public lua_settable: (a: LuaState, b: number) => void
    public lua_setfield: (a: LuaState, b: number, c: string | null) => void
    public lua_seti: (a: LuaState, b: number, c: bigint) => void
    public lua_rawset: (a: LuaState, b: number) => void
    public lua_rawseti: (a: LuaState, b: number, c: bigint) => void
    public lua_rawsetp: (a: LuaState, b: number, c: number | null) => void
    public lua_setmetatable: (a: LuaState, b: number) => number
    public lua_setiuservalue: (a: LuaState, b: number, c: number) => number
    public lua_callk: (a: LuaState, b: number, c: number, d: number, e: number | null) => void
    public lua_pcallk: (a: LuaState, b: number, c: number, d: number, e: number, f: number | null) => number
    public lua_load: (a: LuaState, b: number | null, c: number | null, d: string | null, e: string | null) => LuaReturn
    public lua_dump: (a: LuaState, b: number | null, c: number | null, d: number) => number
    public lua_yieldk: (a: LuaState, b: number, c: number, d: number | null) => number
    public lua_resume: (a: LuaState, b: LuaState | null, c: number, d: number | null) => LuaReturn
    public lua_status: (a: LuaState) => LuaReturn
    public lua_isyieldable: (a: LuaState) => number
    public lua_setwarnf: (a: LuaState, b: number | null, c: number | null) => void
    public lua_warning: (a: LuaState, b: string | null, c: number) => void
    public lua_error: (a: LuaState) => number
    public lua_next: (a: LuaState, b: number) => number
    public lua_concat: (a: LuaState, b: number) => void
    public lua_len: (a: LuaState, b: number) => void
    public lua_stringtonumber: (a: LuaState, b: string | null) => number
    public lua_getallocf: (a: LuaState, b: number | null) => number
    public lua_setallocf: (a: LuaState, b: number | null, c: number | null) => void
    public lua_toclose: (a: LuaState, b: number) => void
    public lua_closeslot: (a: LuaState, b: number) => void
    public lua_getstack: (a: LuaState, b: number, c: number | null) => number
    public lua_getinfo: (a: LuaState, b: string | null, c: number | null) => number
    public lua_getlocal: (a: LuaState, b: number | null, c: number) => string
    public lua_setlocal: (a: LuaState, b: number | null, c: number) => string
    public lua_getupvalue: (a: LuaState, b: number, c: number) => string
    public lua_setupvalue: (a: LuaState, b: number, c: number) => string
    public lua_upvalueid: (a: LuaState, b: number, c: number) => number
    public lua_upvaluejoin: (a: LuaState, b: number, c: number, d: number, e: number) => void
    public lua_sethook: (a: LuaState, b: number | null, c: number, d: number) => void
    public lua_gethook: (a: LuaState) => number
    public lua_gethookmask: (a: LuaState) => number
    public lua_gethookcount: (a: LuaState) => number
    public lua_setcstacklimit: (a: LuaState, b: number) => number
    public luaopen_base: (a: LuaState) => number
    public luaopen_coroutine: (a: LuaState) => number
    public luaopen_table: (a: LuaState) => number
    public luaopen_io: (a: LuaState) => number
    public luaopen_os: (a: LuaState) => number
    public luaopen_string: (a: LuaState) => number
    public luaopen_utf8: (a: LuaState) => number
    public luaopen_math: (a: LuaState) => number
    public luaopen_debug: (a: LuaState) => number
    public luaopen_package: (a: LuaState) => number
    public luaL_openlibs: (a: LuaState) => void

    private referenceTracker = new WeakMap<any, ReferenceMetadata>()
    private referenceMap = new Map<number, any>()
    private availableReferences: number[] = []
    private lastRefIndex?: number

    public constructor(module: LuaEmscriptenModule) {
        this._emscripten = module

        this.luaL_checkversion_ = this.cwrap('luaL_checkversion_', null, ['number', 'number', 'number'])
        this.luaL_getmetafield = this.cwrap('luaL_getmetafield', 'number', ['number', 'number', 'string'])
        this.luaL_callmeta = this.cwrap('luaL_callmeta', 'number', ['number', 'number', 'string'])
        this.luaL_tolstring = this.cwrap('luaL_tolstring', 'string', ['number', 'number', 'number'])
        this.luaL_argerror = this.cwrap('luaL_argerror', 'number', ['number', 'number', 'string'])
        this.luaL_typeerror = this.cwrap('luaL_typeerror', 'number', ['number', 'number', 'string'])
        this.luaL_checklstring = this.cwrap('luaL_checklstring', 'string', ['number', 'number', 'number'])
        this.luaL_optlstring = this.cwrap('luaL_optlstring', 'string', ['number', 'number', 'string', 'number'])
        this.luaL_checknumber = this.cwrap('luaL_checknumber', 'number', ['number', 'number'])
        this.luaL_optnumber = this.cwrap('luaL_optnumber', 'number', ['number', 'number', 'number'])
        this.luaL_checkinteger = this.cwrap('luaL_checkinteger', 'number', ['number', 'number'])
        this.luaL_optinteger = this.cwrap('luaL_optinteger', 'number', ['number', 'number', 'number'])
        this.luaL_checkstack = this.cwrap('luaL_checkstack', null, ['number', 'number', 'string'])
        this.luaL_checktype = this.cwrap('luaL_checktype', null, ['number', 'number', 'number'])
        this.luaL_checkany = this.cwrap('luaL_checkany', null, ['number', 'number'])
        this.luaL_newmetatable = this.cwrap('luaL_newmetatable', 'number', ['number', 'string'])
        this.luaL_setmetatable = this.cwrap('luaL_setmetatable', null, ['number', 'string'])
        this.luaL_testudata = this.cwrap('luaL_testudata', 'number', ['number', 'number', 'string'])
        this.luaL_checkudata = this.cwrap('luaL_checkudata', 'number', ['number', 'number', 'string'])
        this.luaL_where = this.cwrap('luaL_where', null, ['number', 'number'])
        this.luaL_fileresult = this.cwrap('luaL_fileresult', 'number', ['number', 'number', 'string'])
        this.luaL_execresult = this.cwrap('luaL_execresult', 'number', ['number', 'number'])
        this.luaL_ref = this.cwrap('luaL_ref', 'number', ['number', 'number'])
        this.luaL_unref = this.cwrap('luaL_unref', null, ['number', 'number', 'number'])
        this.luaL_loadfilex = this.cwrap('luaL_loadfilex', 'number', ['number', 'string', 'string'])
        this.luaL_loadbufferx = this.cwrap('luaL_loadbufferx', 'number', ['number', 'string|number', 'number', 'string|number', 'string'])
        this.luaL_loadstring = this.cwrap('luaL_loadstring', 'number', ['number', 'string'])
        this.luaL_newstate = this.cwrap('luaL_newstate', 'number', [])
        this.luaL_len = this.cwrap('luaL_len', 'number', ['number', 'number'])
        this.luaL_addgsub = this.cwrap('luaL_addgsub', null, ['number', 'string', 'string', 'string'])
        this.luaL_gsub = this.cwrap('luaL_gsub', 'string', ['number', 'string', 'string', 'string'])
        this.luaL_setfuncs = this.cwrap('luaL_setfuncs', null, ['number', 'number', 'number'])
        this.luaL_getsubtable = this.cwrap('luaL_getsubtable', 'number', ['number', 'number', 'string'])
        this.luaL_traceback = this.cwrap('luaL_traceback', null, ['number', 'number', 'string', 'number'])
        this.luaL_requiref = this.cwrap('luaL_requiref', null, ['number', 'string', 'number', 'number'])
        this.luaL_openselectedlibs = this.cwrap('luaL_openselectedlibs', null, ['number', 'number', 'number'])
        this.luaL_buffinit = this.cwrap('luaL_buffinit', null, ['number', 'number'])
        this.luaL_prepbuffsize = this.cwrap('luaL_prepbuffsize', 'string', ['number', 'number'])
        this.luaL_addlstring = this.cwrap('luaL_addlstring', null, ['number', 'string', 'number'])
        this.luaL_addstring = this.cwrap('luaL_addstring', null, ['number', 'string'])
        this.luaL_addvalue = this.cwrap('luaL_addvalue', null, ['number'])
        this.luaL_pushresult = this.cwrap('luaL_pushresult', null, ['number'])
        this.luaL_pushresultsize = this.cwrap('luaL_pushresultsize', null, ['number', 'number'])
        this.luaL_buffinitsize = this.cwrap('luaL_buffinitsize', 'string', ['number', 'number', 'number'])
        this.lua_newstate = this.cwrap('lua_newstate', 'number', ['number', 'number', 'number'])
        this.lua_close = this.cwrap('lua_close', null, ['number'])
        this.lua_newthread = this.cwrap('lua_newthread', 'number', ['number'])
        this.lua_closethread = this.cwrap('lua_closethread', 'number', ['number', 'number'])
        this.lua_resetthread = (L) => this.lua_closethread(L, null)
        this.lua_atpanic = this.cwrap('lua_atpanic', 'number', ['number', 'number'])
        this.lua_version = this.cwrap('lua_version', 'number', ['number'])
        this.lua_absindex = this.cwrap('lua_absindex', 'number', ['number', 'number'])
        this.lua_gettop = this.cwrap('lua_gettop', 'number', ['number'])
        this.lua_settop = this.cwrap('lua_settop', null, ['number', 'number'])
        this.lua_pushvalue = this.cwrap('lua_pushvalue', null, ['number', 'number'])
        this.lua_rotate = this.cwrap('lua_rotate', null, ['number', 'number', 'number'])
        this.lua_copy = this.cwrap('lua_copy', null, ['number', 'number', 'number'])
        this.lua_checkstack = this.cwrap('lua_checkstack', 'number', ['number', 'number'])
        this.lua_xmove = this.cwrap('lua_xmove', null, ['number', 'number', 'number'])
        this.lua_isnumber = this.cwrap('lua_isnumber', 'number', ['number', 'number'])
        this.lua_isstring = this.cwrap('lua_isstring', 'number', ['number', 'number'])
        this.lua_iscfunction = this.cwrap('lua_iscfunction', 'number', ['number', 'number'])
        this.lua_isinteger = this.cwrap('lua_isinteger', 'number', ['number', 'number'])
        this.lua_isuserdata = this.cwrap('lua_isuserdata', 'number', ['number', 'number'])
        this.lua_type = this.cwrap('lua_type', 'number', ['number', 'number'])
        this.lua_typename = this.cwrap('lua_typename', 'string', ['number', 'number'])
        this.lua_tonumberx = this.cwrap('lua_tonumberx', 'number', ['number', 'number', 'number'])
        this.lua_tointegerx = this.cwrap('lua_tointegerx', 'number', ['number', 'number', 'number'])
        this.lua_toboolean = this.cwrap('lua_toboolean', 'number', ['number', 'number'])
        this.lua_tolstring = this.cwrap('lua_tolstring', 'string', ['number', 'number', 'number'])
        this.lua_rawlen = this.cwrap('lua_rawlen', 'number', ['number', 'number'])
        this.lua_tocfunction = this.cwrap('lua_tocfunction', 'number', ['number', 'number'])
        this.lua_touserdata = this.cwrap('lua_touserdata', 'number', ['number', 'number'])
        this.lua_tothread = this.cwrap('lua_tothread', 'number', ['number', 'number'])
        this.lua_topointer = this.cwrap('lua_topointer', 'number', ['number', 'number'])
        this.lua_arith = this.cwrap('lua_arith', null, ['number', 'number'])
        this.lua_rawequal = this.cwrap('lua_rawequal', 'number', ['number', 'number', 'number'])
        this.lua_compare = this.cwrap('lua_compare', 'number', ['number', 'number', 'number', 'number'])
        this.lua_pushnil = this.cwrap('lua_pushnil', null, ['number'])
        this.lua_pushnumber = this.cwrap('lua_pushnumber', null, ['number', 'number'])
        this.lua_pushinteger = this.cwrap('lua_pushinteger', null, ['number', 'number'])
        this.lua_pushlstring = this.cwrap('lua_pushlstring', 'string', ['number', 'string|number', 'number'])
        this.lua_pushstring = this.cwrap('lua_pushstring', 'string', ['number', 'string|number'])
        this.lua_pushcclosure = this.cwrap('lua_pushcclosure', null, ['number', 'number', 'number'])
        this.lua_pushboolean = this.cwrap('lua_pushboolean', null, ['number', 'number'])
        this.lua_pushlightuserdata = this.cwrap('lua_pushlightuserdata', null, ['number', 'number'])
        this.lua_pushthread = this.cwrap('lua_pushthread', 'number', ['number'])
        this.lua_getglobal = this.cwrap('lua_getglobal', 'number', ['number', 'string'])
        this.lua_gettable = this.cwrap('lua_gettable', 'number', ['number', 'number'])
        this.lua_getfield = this.cwrap('lua_getfield', 'number', ['number', 'number', 'string'])
        this.lua_geti = this.cwrap('lua_geti', 'number', ['number', 'number', 'number'])
        this.lua_rawget = this.cwrap('lua_rawget', 'number', ['number', 'number'])
        this.lua_rawgeti = this.cwrap('lua_rawgeti', 'number', ['number', 'number', 'number'])
        this.lua_rawgetp = this.cwrap('lua_rawgetp', 'number', ['number', 'number', 'number'])
        this.lua_createtable = this.cwrap('lua_createtable', null, ['number', 'number', 'number'])
        this.lua_newuserdatauv = this.cwrap('lua_newuserdatauv', 'number', ['number', 'number', 'number'])
        this.lua_getmetatable = this.cwrap('lua_getmetatable', 'number', ['number', 'number'])
        this.lua_getiuservalue = this.cwrap('lua_getiuservalue', 'number', ['number', 'number', 'number'])
        this.lua_setglobal = this.cwrap('lua_setglobal', null, ['number', 'string'])
        this.lua_settable = this.cwrap('lua_settable', null, ['number', 'number'])
        this.lua_setfield = this.cwrap('lua_setfield', null, ['number', 'number', 'string'])
        this.lua_seti = this.cwrap('lua_seti', null, ['number', 'number', 'number'])
        this.lua_rawset = this.cwrap('lua_rawset', null, ['number', 'number'])
        this.lua_rawseti = this.cwrap('lua_rawseti', null, ['number', 'number', 'number'])
        this.lua_rawsetp = this.cwrap('lua_rawsetp', null, ['number', 'number', 'number'])
        this.lua_setmetatable = this.cwrap('lua_setmetatable', 'number', ['number', 'number'])
        this.lua_setiuservalue = this.cwrap('lua_setiuservalue', 'number', ['number', 'number', 'number'])
        this.lua_callk = this.cwrap('lua_callk', null, ['number', 'number', 'number', 'number', 'number'])
        this.lua_pcallk = this.cwrap('lua_pcallk', 'number', ['number', 'number', 'number', 'number', 'number', 'number'])
        this.lua_load = this.cwrap('lua_load', 'number', ['number', 'number', 'number', 'string', 'string'])
        this.lua_dump = this.cwrap('lua_dump', 'number', ['number', 'number', 'number', 'number'])
        this.lua_yieldk = this.cwrap('lua_yieldk', 'number', ['number', 'number', 'number', 'number'])
        this.lua_resume = this.cwrap('lua_resume', 'number', ['number', 'number', 'number', 'number'])
        this.lua_status = this.cwrap('lua_status', 'number', ['number'])
        this.lua_isyieldable = this.cwrap('lua_isyieldable', 'number', ['number'])
        this.lua_setwarnf = this.cwrap('lua_setwarnf', null, ['number', 'number', 'number'])
        this.lua_warning = this.cwrap('lua_warning', null, ['number', 'string', 'number'])
        this.lua_error = this.cwrap('lua_error', 'number', ['number'])
        this.lua_next = this.cwrap('lua_next', 'number', ['number', 'number'])
        this.lua_concat = this.cwrap('lua_concat', null, ['number', 'number'])
        this.lua_len = this.cwrap('lua_len', null, ['number', 'number'])
        this.lua_stringtonumber = this.cwrap('lua_stringtonumber', 'number', ['number', 'string'])
        this.lua_getallocf = this.cwrap('lua_getallocf', 'number', ['number', 'number'])
        this.lua_setallocf = this.cwrap('lua_setallocf', null, ['number', 'number', 'number'])
        this.lua_toclose = this.cwrap('lua_toclose', null, ['number', 'number'])
        this.lua_closeslot = this.cwrap('lua_closeslot', null, ['number', 'number'])
        this.lua_getstack = this.cwrap('lua_getstack', 'number', ['number', 'number', 'number'])
        this.lua_getinfo = this.cwrap('lua_getinfo', 'number', ['number', 'string', 'number'])
        this.lua_getlocal = this.cwrap('lua_getlocal', 'string', ['number', 'number', 'number'])
        this.lua_setlocal = this.cwrap('lua_setlocal', 'string', ['number', 'number', 'number'])
        this.lua_getupvalue = this.cwrap('lua_getupvalue', 'string', ['number', 'number', 'number'])
        this.lua_setupvalue = this.cwrap('lua_setupvalue', 'string', ['number', 'number', 'number'])
        this.lua_upvalueid = this.cwrap('lua_upvalueid', 'number', ['number', 'number', 'number'])
        this.lua_upvaluejoin = this.cwrap('lua_upvaluejoin', null, ['number', 'number', 'number', 'number', 'number'])
        this.lua_sethook = this.cwrap('lua_sethook', null, ['number', 'number', 'number', 'number'])
        this.lua_gethook = this.cwrap('lua_gethook', 'number', ['number'])
        this.lua_gethookmask = this.cwrap('lua_gethookmask', 'number', ['number'])
        this.lua_gethookcount = this.cwrap('lua_gethookcount', 'number', ['number'])
        // Deprecated in Lua 5.5; keep the JS API surface as a no-op compatibility shim.
        this.lua_setcstacklimit = () => 0
        this.luaopen_base = this.cwrap('luaopen_base', 'number', ['number'])
        this.luaopen_coroutine = this.cwrap('luaopen_coroutine', 'number', ['number'])
        this.luaopen_table = this.cwrap('luaopen_table', 'number', ['number'])
        this.luaopen_io = this.cwrap('luaopen_io', 'number', ['number'])
        this.luaopen_os = this.cwrap('luaopen_os', 'number', ['number'])
        this.luaopen_string = this.cwrap('luaopen_string', 'number', ['number'])
        this.luaopen_utf8 = this.cwrap('luaopen_utf8', 'number', ['number'])
        this.luaopen_math = this.cwrap('luaopen_math', 'number', ['number'])
        this.luaopen_debug = this.cwrap('luaopen_debug', 'number', ['number'])
        this.luaopen_package = this.cwrap('luaopen_package', 'number', ['number'])
        this.luaL_openlibs = (L) => this.luaL_openselectedlibs(L, -1, 0)
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

    public lua_upvalueindex(index: number): number {
        return LUA_REGISTRYINDEX - index
    }

    public ref(data: unknown): number {
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

        this.lastRefIndex = index

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

    // This is needed for some tests
    public getLastRefIndex(): number | undefined {
        return this.lastRefIndex
    }

    public printRefs(): void {
        for (const [key, value] of this.referenceMap.entries()) {
            console.log(key, value)
        }
    }

    private cwrap(
        name: string,
        returnType: Emscripten.JSType | null,
        argTypes: Array<Emscripten.JSType | 'string|number'>,
    ): (...args: any[]) => any {
        // optimization for common case
        const hasStringOrNumber = argTypes.some((argType) => argType === 'string|number')
        if (!hasStringOrNumber) {
            return (...args: any[]) =>
                this._emscripten.ccall(name, returnType, argTypes as Emscripten.JSType[], args as Emscripten.TypeCompatibleWithC[])
        }

        return (...args: any[]) => {
            const pointersToBeFreed: number[] = []
            const resolvedArgTypes: Emscripten.JSType[] = argTypes.map((argType, i) => {
                if (argType === 'string|number') {
                    if (typeof args[i] === 'number') {
                        return 'number'
                    } else {
                        // because it will be freed later, this can only be used on functions that lua internally copies the string
                        if (args[i]?.length > 1024) {
                            const bufferPointer = this._emscripten.stringToNewUTF8(args[i] as string)
                            args[i] = bufferPointer
                            pointersToBeFreed.push(bufferPointer)
                            return 'number'
                        } else {
                            return 'string'
                        }
                    }
                }
                return argType
            })

            try {
                return this._emscripten.ccall(name, returnType, resolvedArgTypes, args as Emscripten.TypeCompatibleWithC[])
            } finally {
                for (const pointer of pointersToBeFreed) {
                    this._emscripten._free(pointer)
                }
            }
        }
    }
}

function createOutputWriter(writer?: (content: string) => void): ((charCode: number | null) => void) | null {
    if (!writer) {
        return null
    }

    let buffer = ''
    return (charCode: number | null): void => {
        if (charCode === null || charCode === 10) {
            writer(buffer)
            buffer = ''
            return
        }

        if (charCode !== 13) {
            buffer += String.fromCharCode(charCode)
        }
    }
}
