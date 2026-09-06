// The types below are `@types/emscripten`'s ambient globals. They only resolve for a consumer who
// lists "emscripten" in their own tsconfig `types`, so utils/reference-types.js puts a
// `/// <reference types="emscripten" />` at the top of the emitted declarations to cover everyone
// else. tsc drops the directive when it is written here, hence the build step.
import initWasmModule from '../build/glue.js'
import { settleOrInterrupt } from './async'
import { defaultWarnHandler, LUA_REGISTRYINDEX, type LuaAddress, LuaReturn, LuaType, type LuaWarnHandler, PointerSize } from './types'
// A rolldown plugin will resolve this to the current version on package.json
import version from 'package-version'

export type EnvironmentVariables = Record<string, string | undefined>

/**
 * Which filesystem the Lua states see.
 *
 * - `'memory'`: Emscripten's in-memory filesystem, holding nothing but `/tmp`, `/home` and `/dev`.
 *   Identical in every environment, and reaches nothing on the host until a directory is handed to
 *   it through {@link LuaModuleOptions.mounts}.
 * - `'host'`: the real filesystem, through Node. Paths, the working directory, symlinks and
 *   permissions are the host's own, because every operation goes straight to `node:fs`. Node only,
 *   and no sandbox: Lua can read and write anything the process can.
 */
export type LuaFileSystem = 'memory' | 'host'

/** Emscripten's own path helpers, which work on the virtual filesystem rather than the host one. */
export interface EmscriptenPath {
    isAbs: (path: string) => boolean
    normalize: (path: string) => string
    dirname: (path: string) => string
    basename: (path: string) => string
    join: (...paths: string[]) => string
    join2: (left: string, right: string) => string
}

/** The instantiated wasm module, as {@link LuaModule.emscripten}. */
export interface LuaEmscriptenModule extends EmscriptenModule {
    addFunction: typeof addFunction
    removeFunction: typeof removeFunction
    setValue: typeof setValue
    getValue: typeof getValue
    // `filesystems` is the only member missing upstream; mkdirTree and the rest come from typeof FS.
    FS: typeof FS & {
        filesystems: {
            NODEFS: Emscripten.FileSystemType
            MEMFS: Emscripten.FileSystemType
        }
    }
    PATH: EmscriptenPath
    stringToNewUTF8: typeof stringToNewUTF8
    lengthBytesUTF8: typeof lengthBytesUTF8
    stringToUTF8: typeof stringToUTF8
    UTF8ToString: (ptr: number, maxBytesToRead?: number, ignoreNul?: boolean) => string
    // Scratch space for a C string argument, on the wasm stack. Unwound by stackRestore rather
    // than freed, so it stays correct when a Lua error longjmps out of the call.
    stringToUTF8OnStack: (str: string) => number
    stackSave: () => number
    stackRestore: (pointer: number) => void
    ENV: EnvironmentVariables
    _realloc: (pointer: number, size: number) => number
}

/**
 * The filesystem every state on a runtime shares, as {@link LuaModule.emscripten}'s `FS`. In memory
 * unless the module was loaded with `fs: 'host'`, where the same API acts on the real one.
 */
export type EmscriptenFS = LuaEmscriptenModule['FS']

export interface LuaModuleOptions {
    /**
     * Where to load `glue.wasm` from. Defaults to next to this module, falling back to unpkg when
     * there is nothing there to fetch (a page opened from `file:`, say).
     */
    wasmFile?: string | undefined
    /** Environment variables for the Lua states. */
    env?: EnvironmentVariables | undefined
    /** Which filesystem the Lua states see. Defaults to `'memory'`. */
    fs?: LuaFileSystem | undefined
    /**
     * Host directories to expose in the in-memory filesystem, keyed by the absolute path Lua sees.
     * `{ '/scripts': './lua' }` makes `./lua/init.lua` readable and writable as `/scripts/init.lua`
     * and leaves the rest of the host unreachable. Node only, and only with `fs: 'memory'`.
     *
     * Mount points cannot nest, and a host path has to name a directory that already exists.
     */
    mounts?: Readonly<Record<string, string>> | undefined
    /** Called once per read. An empty string (or nothing) means EOF. */
    stdin?: (() => string | null | undefined) | undefined
    /**
     * Called with each completed line, without the line break, and with a partial line when Lua
     * flushes or suspends in the middle of one.
     */
    stdout?: ((content: string) => void) | undefined
    stderr?: ((content: string) => void) | undefined
    /**
     * Where diagnostics go, both while loading and from every state created on the runtime unless
     * that state overrides it. Defaults to `console.warn`.
     */
    onWarn?: LuaWarnHandler | undefined
    /**
     * Which async engine to run under. `'auto'` (the default) uses JSPI where the platform has it,
     * so an `:await()` can suspend the wasm stack anywhere, and falls back to the coroutine
     * yielding engine otherwise. `'jspi'` requires JSPI and throws if it is missing; `'yield'`
     * forces the fallback, which is useful for tests and for matching the fallback's semantics.
     */
    async?: 'auto' | 'jspi' | 'yield' | undefined
}

// One-shot conversions, so a single stateless codec pair is shared by every module. Streaming
// output keeps its own decoder in createOutputWriter, since a flush can cut a character in half.
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// Above this a dedicated allocation is used, so one huge string cannot permanently retain the
// scratch buffer.
const REUSABLE_STRING_BUFFER_LIMIT = 64 * 1024
// Worst case UTF-8 expansion for a JS (UTF-16) string.
const MAX_UTF8_BYTES_PER_CHAR = 3

// C string arguments are nearly always a fixed name -- a metatable name, '__name', a global or a
// table key -- so their encoded form is kept instead of being rebuilt on every call. Bounded in
// both directions because a caller can also index with arbitrary strings; past either bound the
// wasm stack is used the way ccall does it.
const C_STRING_CACHE_LIMIT = 512
const C_STRING_CACHE_MAX_LENGTH = 128

/** How a marshalled string argument is turned into a pointer. Ordered so `None` is falsy. */
const enum StringArgument {
    None = 0,
    /** A fixed name, worth keeping the encoded form of. */
    Cached = 1,
    /** A one-off, encoded into scratch space every time so it cannot fill the cache. */
    Uncached = 2,
}

// Past this a marshalled string is put on the heap and freed as the call returns, rather than on the
// wasm stack: that is 1MB, shared with the Lua calls made through it, and a whole chunk of source
// passed to one of these would overflow it.
const STACK_STRING_LIMIT = 1024

// Above this, TextEncoder beats copying byte by byte in JS (measured).
const INLINE_ENCODE_LIMIT = 40
// Above this, TextDecoder beats gathering the bytes in JS (measured). Its cost is nearly flat --
// mostly the subarray view and the call -- while the inline path grows per byte; the two cross
// here. Most reads are well under it: table keys, global names, short values.
const INLINE_DECODE_LIMIT = 32

// The wasm value types Emscripten's function signature letters map to. `p` is a pointer, which is
// an i32 in a build without MEMORY64.
const WASM_SIGNATURE_TYPES: Record<string, number> = { i: 0x7f, p: 0x7f, j: 0x7e, f: 0x7d, d: 0x7c, e: 0x6f }

function wasmType(signature: string, letter: string): number {
    const type = WASM_SIGNATURE_TYPES[letter]
    if (type === undefined) {
        throw new Error(`unsupported wasm signature '${signature}': no type for '${letter}'`)
    }
    return type
}

/**
 * A wasm module exporting a single imported function unchanged, which is how a JS callback is
 * given the wasm identity the indirect function table requires. See {@link LuaModule.addFunction}.
 */
function buildTrampolineModule(signature: string): WebAssembly.Module {
    const parameters = [...signature.slice(1)].map((letter) => wasmType(signature, letter))
    const results = signature[0] === 'v' ? [] : [wasmType(signature, signature[0])]
    // Every count below is written as one byte, which LEB128 agrees with under 128.
    if (parameters.length > 0x7f) {
        throw new Error(`unsupported wasm signature '${signature}': ${parameters.length} parameters`)
    }

    // func type: params -> results
    const functionType = [0x60, parameters.length, ...parameters, results.length, ...results]
    const typeSection = [0x01, functionType.length + 1, 0x01, ...functionType]
    // import "e"."f" as function 0, then export it as "f"
    const importSection = [0x02, 0x07, 0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00]
    const exportSection = [0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00]

    return new WebAssembly.Module(Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...typeSection, ...importSection, ...exportSection]))
}

interface ReferenceMetadata {
    index: number
    refCount: number
}

/** A {@link LuaModuleOptions.mounts} entry with both sides checked, ready for `FS.mount`. */
interface ResolvedMount {
    /** Absolute, with no trailing slash and no `.` or `..` in it. */
    virtualPath: string
    /** Absolute host path of a directory that exists. */
    hostPath: string
}

// The only rule about `mounts` that is not about a single mount, so both the option and the method
// report it with one voice.
const MOUNTS_NEED_MEMORY_FS = `mounts belong to fs: 'memory'; with 'host' every host path is already reachable`

/**
 * Synchronous and lazy, which is what lets a mount be added after loading without the load path
 * paying for a `node:fs` import it usually has no use for. Null anywhere but Node.
 */
function nodeBuiltin<T>(name: string): T | null {
    return (globalThis.process?.getBuiltinModule?.(name) as T | undefined) ?? null
}

/**
 * Nothing here is left to fail later: an unreadable host path, or a mount point Emscripten would
 * put somewhere unexpected, is an error at once rather than a directory that silently turns up empty.
 */
function resolveMount(virtualPath: string, hostPath: string): ResolvedMount {
    const where = `cannot mount '${hostPath}' at '${virtualPath}'`

    const fs = nodeBuiltin<typeof import('node:fs')>('node:fs')
    const path = nodeBuiltin<typeof import('node:path')>('node:path')
    if (!fs || !path) {
        throw new Error(`${where}: reaching a host directory needs node:fs, which only Node has`)
    }

    // Absolute, at least one segment deep, and nothing that would move the mount elsewhere. Not
    // normalized on the caller's behalf, so a path that means something else is refused rather than
    // quietly changed.
    const mountPoint = virtualPath.replace(/\/+$/, '')
    if (!/^(\/[^/]+)+$/.test(mountPoint)) {
        throw new Error(`${where}: the mount point has to be an absolute path below the root, such as '/scripts'`)
    }
    if (mountPoint.split('/').some((segment) => segment === '.' || segment === '..')) {
        throw new Error(`${where}: the mount point has to be a normalized path, with no '.' or '..' segments`)
    }

    if (hostPath.startsWith('~')) {
        // Expanded by a shell rather than by node:path, so it would resolve to a directory named
        // '~' below the cwd -- which is never what the caller meant.
        throw new Error(`${where}: '~' is not expanded, so pass an absolute path (os.homedir() and a join)`)
    }
    const root = path.resolve(hostPath)

    let isDirectory: boolean
    try {
        isDirectory = fs.statSync(root).isDirectory()
    } catch (err) {
        throw new Error(`${where}: '${root}' could not be read`, { cause: err })
    }
    if (!isDirectory) {
        // NODEFS mounts lazily and would not notice until the first lookup inside it failed.
        throw new Error(`${where}: '${root}' is not a directory`)
    }

    return { virtualPath: mountPoint, hostPath: root }
}

/**
 * A mount inside another one would have its mount point created on the host it is mounted from, so
 * the two have to be disjoint. Checked against the mounts that are already live, which is what makes
 * the rule the same whether a mount arrives with the options or afterwards.
 */
function assertMountFits(live: readonly ResolvedMount[], candidate: ResolvedMount): void {
    // The trailing slash on both sides keeps '/scripts2' from counting as being inside '/scripts',
    // and an equal pair matches in both directions, so a mount point is never claimed twice.
    const overlapping = live.find(
        (mount) =>
            `${candidate.virtualPath}/`.startsWith(`${mount.virtualPath}/`) ||
            `${mount.virtualPath}/`.startsWith(`${candidate.virtualPath}/`),
    )
    if (overlapping) {
        throw new Error(`cannot mount at '${candidate.virtualPath}': it overlaps the mount point '${overlapping.virtualPath}'`)
    }
}

/** Everything the wasm module needs before it starts, and nothing that outlives that. */
interface PreRunConfig {
    env: EnvironmentVariables | undefined
    mounts: readonly ResolvedMount[]
    stdin: LuaModuleOptions['stdin']
    stdout: LuaModuleOptions['stdout']
    stderr: LuaModuleOptions['stderr']
}

/**
 * Built from a record rather than closed over `initialize`'s scope, because Emscripten keeps
 * `Module.preRun` for the module's lifetime and a closure would pin everything around it with it.
 */
function createPreRun(config: PreRunConfig): (initializedModule: LuaEmscriptenModule) => void {
    return (initializedModule: LuaEmscriptenModule): void => {
        if (typeof config.env === 'object') {
            Object.assign(initializedModule.ENV, config.env)
        }

        // Nothing to do for `fs: 'host'`: that glue is NODERAWFS, so the filesystem already is the
        // host's, working directory included.
        for (const { virtualPath, hostPath } of config.mounts) {
            const fs = initializedModule.FS
            fs.mkdirTree(virtualPath)
            fs.mount(fs.filesystems.NODEFS, { root: hostPath }, virtualPath)
        }

        if (config.stdin || config.stdout || config.stderr) {
            initializedModule.FS.init(createInputReader(config.stdin), createOutputWriter(config.stdout), createOutputWriter(config.stderr))
        }
    }
}

export default class LuaModule {
    public static async initialize(opts: Readonly<LuaModuleOptions> = {}): Promise<LuaModule> {
        const warn = opts.onWarn ?? defaultWarnHandler
        // Node rather than the browser, because the lookalikes (jsdom, an Electron renderer) are
        // Node with a DOM bolted on, and asking about `window` gets those wrong.
        const isNode = typeof globalThis.process?.versions?.node === 'string'

        const fs = opts.fs ?? 'memory'
        const mountEntries = Object.entries(opts.mounts ?? {})

        if (fs === 'host' && !isNode) {
            throw new Error(`fs: 'host' is the real filesystem, which only Node has; elsewhere use the default 'memory' one`)
        }
        if (fs === 'host' && mountEntries.length > 0) {
            throw new Error(MOUNTS_NEED_MEMORY_FS)
        }

        // Resolved before the wasm is instantiated, so a mount that cannot work fails the load
        // rather than leaving a module behind. Each one is checked against those already accepted,
        // which is the same rule LuaModule.mount applies to a later arrival.
        const mounts: ResolvedMount[] = []
        for (const [virtualPath, hostPath] of mountEntries) {
            const mount = resolveMount(virtualPath, hostPath)
            assertMountFits(mounts, mount)
            mounts.push(mount)
        }

        // Emscripten reports load failures itself, which is noise while one can still be recovered
        // from below, so they are held until the outcome is known. Null once handed over.
        let buffered: string[] | null = []
        const printErr = (line: string): void => {
            if (buffered) {
                buffered.push(line)
            } else {
                warn(line)
            }
        }

        const preRun = createPreRun({ env: opts.env, mounts, stdin: opts.stdin, stdout: opts.stdout, stderr: opts.stderr })

        // Two glues over the one wasm, differing only in their filesystem (see
        // utils/build-wasm.sh). The host one is imported on demand, both because it throws outside
        // Node and so that a browser bundle leaves it in a chunk it never loads.
        const init = fs === 'host' ? (await import('../build/host/glue.js')).default : initWasmModule
        if (typeof init !== 'function') {
            // The `browser` field points bundlers at a stub, since the glue only runs under Node.
            throw new Error(`fs: 'host' needs glue-host.js, which the bundle replaced with a stub because it targets the browser`)
        }

        const asyncEngine = opts.async ?? 'auto'
        const load = async (wasmFile?: string): Promise<LuaModule> => {
            return new LuaModule(
                await init({ ...(wasmFile === undefined ? {} : { locateFile: () => wasmFile }), preRun, printErr }),
                opts.onWarn,
                fs,
                mounts,
                asyncEngine,
            )
        }

        try {
            if (opts.wasmFile !== undefined) {
                return await load(opts.wasmFile)
            }

            try {
                // Left to emscripten, which resolves it with `new URL('glue.wasm', import.meta.url)`
                // -- the shape bundlers look for to emit or inline the asset, and one a locateFile
                // of our own would hide from them.
                return await load()
            } catch (err) {
                // A browser can recover: a page opened from file: cannot fetch a sibling at all, and
                // a bundler that neither emits nor inlines the asset leaves nothing there either. In
                // Node it is just a broken install.
                if (isNode) {
                    throw err
                }

                // Pinned to this version, so it only covers a published release.
                const remoteWasmFile = `https://unpkg.com/wasmoon@${version}/dist/glue.wasm`
                warn(`could not load glue.wasm from next to the bundle, falling back to ${remoteWasmFile}`, err)
                buffered = []

                try {
                    return await load(remoteWasmFile)
                } catch (remoteErr) {
                    throw new Error(
                        `failed to load the Lua wasm module, both from next to the bundle and from ${remoteWasmFile}. ` +
                            `The fallback only covers published versions of wasmoon, so pass wasmFile to point at your own copy.`,
                        { cause: remoteErr },
                    )
                }
            }
        } finally {
            // What is left belongs to the attempt that decided the outcome.
            for (const line of buffered ?? []) {
                warn(line)
            }
            buffered = null
        }
    }

    public emscripten: LuaEmscriptenModule
    /** The handler passed to {@link LuaModule.initialize}, which states created on it inherit. */
    public readonly onWarn: LuaWarnHandler | undefined
    /** Which filesystem this module was loaded with, as {@link LuaModuleOptions.fs}. */
    public readonly fs: LuaFileSystem
    /** The async engine requested at load, as {@link LuaModuleOptions.async}. */
    public readonly asyncEngine: 'auto' | 'jspi' | 'yield'

    public luaL_checkversion_: (L: LuaAddress, ver: number, sz: number) => void
    public luaL_getmetafield: (L: LuaAddress, obj: number, e: string | null) => LuaType
    public luaL_callmeta: (L: LuaAddress, obj: number, e: string | null) => number
    public luaL_argerror: (L: LuaAddress, arg: number, extramsg: string | null) => number
    public luaL_typeerror: (L: LuaAddress, arg: number, tname: string | null) => number
    public luaL_checklstring: (L: LuaAddress, arg: number, l: number | null) => string
    public luaL_optlstring: (L: LuaAddress, arg: number, def: string | null, l: number | null) => string
    public luaL_checknumber: (L: LuaAddress, arg: number) => number
    public luaL_optnumber: (L: LuaAddress, arg: number, def: number) => number
    // lua_Integer is 64 bit, and the module is built with WASM_BIGINT, so these cross as BigInt.
    public luaL_checkinteger: (L: LuaAddress, arg: number) => bigint
    public luaL_optinteger: (L: LuaAddress, arg: number, def: bigint) => bigint
    public luaL_checkstack: (L: LuaAddress, sz: number, msg: string | null) => void
    public luaL_checktype: (L: LuaAddress, arg: number, t: number) => void
    public luaL_checkany: (L: LuaAddress, arg: number) => void
    public luaL_newmetatable: (L: LuaAddress, tname: string | null) => number
    public luaL_setmetatable: (L: LuaAddress, tname: string | null) => void
    public luaL_testudata: (L: LuaAddress, ud: number, tname: string | null) => LuaAddress
    public luaL_checkudata: (L: LuaAddress, ud: number, tname: string | null) => LuaAddress
    public luaL_where: (L: LuaAddress, lvl: number) => void
    public luaL_fileresult: (L: LuaAddress, stat: number, fname: string | null) => number
    public luaL_execresult: (L: LuaAddress, stat: number) => number
    public luaL_ref: (L: LuaAddress, t: number) => number
    public luaL_unref: (L: LuaAddress, t: number, ref: number) => void
    public luaL_loadfilex: (L: LuaAddress, filename: string | null, mode: string | null) => LuaReturn
    public luaL_loadbufferx: (
        L: LuaAddress,
        buff: string | number | null,
        sz: number,
        name: string | number | null,
        mode: string | null,
    ) => LuaReturn
    public luaL_loadstring: (L: LuaAddress, s: string | null) => LuaReturn
    public luaL_newstate: () => LuaAddress
    public luaL_len: (L: LuaAddress, idx: number) => bigint
    public luaL_addgsub: (b: number | null, s: string | null, p: string | null, r: string | null) => void
    public luaL_gsub: (L: LuaAddress, s: string | null, p: string | null, r: string | null) => string
    public luaL_setfuncs: (L: LuaAddress, l: number | null, nup: number) => void
    public luaL_getsubtable: (L: LuaAddress, idx: number, fname: string | null) => number
    public luaL_traceback: (L: LuaAddress, L1: LuaAddress, msg: string | null, level: number) => void
    public luaL_requiref: (L: LuaAddress, modname: string | null, openf: number, glb: number) => void
    public luaL_openselectedlibs: (L: LuaAddress, load: number, preload: number) => void
    public luaL_buffinit: (L: LuaAddress, B: number | null) => void
    public luaL_prepbuffsize: (B: number | null, sz: number) => string
    public luaL_addlstring: (B: number | null, s: string | null, l: number) => void
    public luaL_addstring: (B: number | null, s: string | null) => void
    public luaL_addvalue: (B: number | null) => void
    public luaL_pushresult: (B: number | null) => void
    public luaL_pushresultsize: (B: number | null, sz: number) => void
    public luaL_buffinitsize: (L: LuaAddress, B: number | null, sz: number) => string
    public lua_newstate: (f: number | null, ud: number | null, seed: number) => LuaAddress
    public lua_close: (L: LuaAddress) => void
    public lua_newthread: (L: LuaAddress) => LuaAddress
    public lua_closethread: (L: LuaAddress, from: LuaAddress | null) => LuaReturn
    public lua_resetthread: (L: LuaAddress) => LuaReturn
    public lua_atpanic: (L: LuaAddress, panicf: number) => number
    public lua_version: (L: LuaAddress) => number
    public lua_absindex: (L: LuaAddress, idx: number) => number
    public lua_gettop: (L: LuaAddress) => number
    public lua_settop: (L: LuaAddress, idx: number) => void
    public lua_pushvalue: (L: LuaAddress, idx: number) => void
    public lua_rotate: (L: LuaAddress, idx: number, n: number) => void
    public lua_copy: (L: LuaAddress, fromidx: number, toidx: number) => void
    public lua_checkstack: (L: LuaAddress, n: number) => number
    public lua_xmove: (from: LuaAddress, to: LuaAddress, n: number) => void
    public lua_isnumber: (L: LuaAddress, idx: number) => number
    public lua_isstring: (L: LuaAddress, idx: number) => number
    public lua_iscfunction: (L: LuaAddress, idx: number) => number
    public lua_isinteger: (L: LuaAddress, idx: number) => number
    public lua_isuserdata: (L: LuaAddress, idx: number) => number
    public lua_type: (L: LuaAddress, idx: number) => LuaType
    public lua_typename: (L: LuaAddress, tp: number) => string
    public lua_tonumberx: (L: LuaAddress, idx: number, isnum: number | null) => number
    public lua_tointegerx: (L: LuaAddress, idx: number, isnum: number | null) => bigint
    public lua_toboolean: (L: LuaAddress, idx: number) => number
    public lua_rawlen: (L: LuaAddress, idx: number) => bigint
    public lua_tocfunction: (L: LuaAddress, idx: number) => number
    public lua_touserdata: (L: LuaAddress, idx: number) => LuaAddress
    public lua_tothread: (L: LuaAddress, idx: number) => LuaAddress
    public lua_topointer: (L: LuaAddress, idx: number) => LuaAddress
    public lua_arith: (L: LuaAddress, op: number) => void
    public lua_rawequal: (L: LuaAddress, idx1: number, idx2: number) => number
    public lua_compare: (L: LuaAddress, idx1: number, idx2: number, op: number) => number
    public lua_pushnil: (L: LuaAddress) => void
    public lua_pushnumber: (L: LuaAddress, n: number) => void
    public lua_pushinteger: (L: LuaAddress, n: number | bigint) => void
    public lua_pushlstring: (L: LuaAddress, s: number, len: number) => void
    public lua_pushcclosure: (L: LuaAddress, fn: number, n: number) => void
    public lua_pushboolean: (L: LuaAddress, b: number) => void
    public lua_pushlightuserdata: (L: LuaAddress, p: number | null) => void
    public lua_pushthread: (L: LuaAddress) => number
    public lua_getglobal: (L: LuaAddress, name: string | null) => LuaType
    public lua_gettable: (L: LuaAddress, idx: number) => LuaType
    public lua_getfield: (L: LuaAddress, idx: number, k: string | null) => LuaType
    public lua_geti: (L: LuaAddress, idx: number, n: number | bigint) => LuaType
    public lua_rawget: (L: LuaAddress, idx: number) => LuaType
    public lua_rawgeti: (L: LuaAddress, idx: number, n: number | bigint) => LuaType
    public lua_rawgetp: (L: LuaAddress, idx: number, p: number | null) => LuaType
    public lua_createtable: (L: LuaAddress, narr: number, nrec: number) => void
    public lua_newuserdatauv: (L: LuaAddress, sz: number, nuvalue: number) => LuaAddress
    public lua_getmetatable: (L: LuaAddress, objindex: number) => number
    public lua_getiuservalue: (L: LuaAddress, idx: number, n: number) => LuaType
    public lua_setglobal: (L: LuaAddress, name: string | null) => void
    public lua_settable: (L: LuaAddress, idx: number) => void
    public lua_setfield: (L: LuaAddress, idx: number, k: string | null) => void
    public lua_seti: (L: LuaAddress, idx: number, n: number | bigint) => void
    public lua_rawset: (L: LuaAddress, idx: number) => void
    public lua_rawseti: (L: LuaAddress, idx: number, n: number | bigint) => void
    public lua_rawsetp: (L: LuaAddress, idx: number, p: number | null) => void
    public lua_setmetatable: (L: LuaAddress, objindex: number) => number
    public lua_setiuservalue: (L: LuaAddress, idx: number, n: number) => number
    public lua_callk: (L: LuaAddress, nargs: number, nresults: number, ctx: number, k: number | null) => void
    public lua_pcallk: (L: LuaAddress, nargs: number, nresults: number, errfunc: number, ctx: number, k: number | null) => LuaReturn
    public lua_load: (L: LuaAddress, reader: number | null, dt: number | null, chunkname: string | null, mode: string | null) => LuaReturn
    public lua_dump: (L: LuaAddress, writer: number | null, data: number | null, strip: number) => number
    public lua_yieldk: (L: LuaAddress, nresults: number, ctx: number, k: number | null) => number
    public lua_resume: (L: LuaAddress, from: LuaAddress | null, narg: number, nres: number | null) => LuaReturn
    public lua_status: (L: LuaAddress) => LuaReturn
    public lua_isyieldable: (L: LuaAddress) => number
    public lua_setwarnf: (L: LuaAddress, f: number | null, ud: number | null) => void
    public lua_warning: (L: LuaAddress, msg: string | null, tocont: number) => void
    public lua_error: (L: LuaAddress) => number
    public lua_next: (L: LuaAddress, idx: number) => number
    public lua_concat: (L: LuaAddress, n: number) => void
    public lua_len: (L: LuaAddress, idx: number) => void
    public lua_stringtonumber: (L: LuaAddress, s: string | null) => number
    public lua_getallocf: (L: LuaAddress, ud: number | null) => number
    public lua_setallocf: (L: LuaAddress, f: number | null, ud: number | null) => void
    public lua_toclose: (L: LuaAddress, idx: number) => void
    public lua_closeslot: (L: LuaAddress, idx: number) => void
    public lua_getstack: (L: LuaAddress, level: number, ar: number | null) => number
    public lua_getinfo: (L: LuaAddress, what: string | null, ar: number | null) => number
    public lua_getlocal: (L: LuaAddress, ar: number | null, n: number) => string
    public lua_setlocal: (L: LuaAddress, ar: number | null, n: number) => string
    public lua_getupvalue: (L: LuaAddress, funcindex: number, n: number) => string
    public lua_setupvalue: (L: LuaAddress, funcindex: number, n: number) => string
    public lua_upvalueid: (L: LuaAddress, fidx: number, n: number) => LuaAddress
    public lua_upvaluejoin: (L: LuaAddress, fidx1: number, n1: number, fidx2: number, n2: number) => void
    public lua_sethook: (L: LuaAddress, func: number | null, mask: number, count: number) => void
    /** Installs the await hook the {@link wasmoon_push_jsfunction} closures suspend through. */
    public wasmoon_set_await_hook: (hook: number) => void
    /** Pops the reference box on the stack and pushes a JS function closure over it and `callHook`. */
    public wasmoon_push_jsfunction: (L: LuaAddress, callHook: number) => void
    public lua_gethook: (L: LuaAddress) => number
    public lua_gethookmask: (L: LuaAddress) => number
    public lua_gethookcount: (L: LuaAddress) => number
    public lua_setcstacklimit: (_L: LuaAddress, _limit: number) => number
    public luaopen_base: (L: LuaAddress) => number
    public luaopen_coroutine: (L: LuaAddress) => number
    public luaopen_table: (L: LuaAddress) => number
    public luaopen_io: (L: LuaAddress) => number
    public luaopen_os: (L: LuaAddress) => number
    public luaopen_string: (L: LuaAddress) => number
    public luaopen_utf8: (L: LuaAddress) => number
    public luaopen_math: (L: LuaAddress) => number
    public luaopen_debug: (L: LuaAddress) => number
    public luaopen_package: (L: LuaAddress) => number
    public luaL_openlibs: (L: LuaAddress) => void
    public lua_gc: (L: LuaAddress, what: number, a: number, b: number) => number

    /** The mounts that are live, so a later one can be checked against them. */
    private readonly mounts: ResolvedMount[]

    private readonly cStringCache = new Map<string, number>()
    private readonly trampolineModules = new Map<string, WebAssembly.Module>()
    private referenceTracker = new WeakMap<any, ReferenceMetadata>()
    private referenceMap = new Map<number, any>()
    private availableReferences: number[] = []
    private lastRefIndex?: number

    // Lua strings are byte arrays that may contain NUL, so they cannot go through Emscripten's
    // NUL-terminated string marshalling. These work on pointers and explicit lengths instead.
    private readonly rawLuaToLString: (L: LuaAddress, idx: number, len: number) => number
    private readonly rawLuaLToLString: (L: LuaAddress, idx: number, len: number) => number
    private readonly rawLuaPushString: (L: LuaAddress, s: number) => number

    // C writes these immediately before returning and we read them straight after with no
    // interleaving await, so a single shared slot each stays reentrancy safe.
    private readonly sizeScratch: number
    /** The two 32 bit slots {@link lua_gc} passes its variadic arguments through. */
    private readonly gcArgsScratch: number
    private readonly rawLuaGc: (L: LuaAddress, what: number, args: number) => number
    /** The `nresults` out parameter for {@link lua_resume}, read by `Thread.resume`. */
    public readonly resultCountScratch: number
    /**
     * The light userdata a run interrupted by the debug hook is unwound with. Nothing but the hook
     * ever pushes this address, and no Lua object can live at it, so finding it on the stack is
     * proof that the error came from a limit rather than from the script -- see `Thread.assertOk`.
     *
     * Pushing the error itself is what this replaced: it goes through pushValue, and a state with no
     * error extension registered marshals it into a plain table, losing the identity the recovery
     * needs. `decorate(error, { as: 'userdata' })` would survive that, but not this: light userdata
     * allocates nothing, and the hook fires at an arbitrary instruction, including under a
     * `memory.max` tight enough that a real userdata would fail and report a memory error in place
     * of the limit that was actually hit.
     */
    public readonly interruptToken: number
    /**
     * The wasm stack pointer while control is in JS with none of our wasm frames below, captured
     * once. A JSPI suspension frees the C stack from the run's frontier up to here, and restores it
     * before resuming. See {@link installAwaitHook}.
     */
    public readonly mainStackPointer: number
    /**
     * Set true only while a JSPI promising resume is the innermost driver on the stack, so an
     * `:await()` knows a suspend would reach a promising boundary. A synchronous entry point
     * (doStringSync, a JS→Lua callback) sets it false around its own resume, so an await there
     * takes the yield path instead of trapping.
     */
    public stackCanSuspend = false
    /**
     * The promise a JSPI `:await()` stashed for the C trampoline's await hook to suspend on, along
     * with how to marshal its settled value back onto the Lua stack. Read synchronously by the
     * await hook right after the await closure returns, so a single slot is reentrancy safe.
     */
    public pendingSuspend:
        | {
              promise: PromiseLike<unknown>
              signal: AbortSignal | undefined
              deadline: number | undefined
              isClosed: () => boolean
              onResolve: (value: unknown) => number
              onReject: (error: unknown) => number
              onInterrupt: () => number
          }
        | undefined
    private awaitHookPointer: number | undefined
    /**
     * The deadline and abort signal of the JSPI run currently resuming, so an `:await()` it reaches
     * can be interrupted while parked. Set around each promising resume rather than read from the
     * awaiting thread, whose JS wrapper is often a fresh object without the run's limits on it.
     */
    public activeRunDeadline: number | undefined
    public activeRunSignal: AbortSignal | undefined
    /**
     * Whether runs on this module go through JSPI. On unless the platform lacks it or `async` asked
     * for the yielding engine, in which case an `:await()` can only park at a coroutine boundary.
     */
    public readonly useJspi: boolean
    /** `promising(lua_resume)`, built once. */
    private promisingResumeFunction:
        | ((L: LuaAddress, from: LuaAddress | null, narg: number, nres: number) => Promise<LuaReturn>)
        | undefined
    private stringBuffer = 0
    /** Built on first use by {@link referenceGcFunction}, then kept for the module's lifetime. */
    private referenceGcPointer: number | undefined

    public constructor(
        module: LuaEmscriptenModule,
        onWarn?: LuaWarnHandler,
        fs: LuaFileSystem = 'memory',
        mounts: readonly ResolvedMount[] = [],
        asyncEngine: 'auto' | 'jspi' | 'yield' = 'auto',
    ) {
        this.emscripten = module
        this.onWarn = onWarn
        this.fs = fs
        this.mounts = [...mounts]
        this.asyncEngine = asyncEngine

        if (asyncEngine === 'jspi' && !this.jspiSupported) {
            throw new Error(
                "async: 'jspi' needs a platform with the JavaScript Promise Integration API and a glue built with SUPPORT_LONGJMP=wasm",
            )
        }

        this.luaL_checkversion_ = this.cwrap('luaL_checkversion_', null, ['number', 'number', 'number'])
        this.luaL_getmetafield = this.cwrap('luaL_getmetafield', 'number', ['number', 'number', 'string'])
        this.luaL_callmeta = this.cwrap('luaL_callmeta', 'number', ['number', 'number', 'string'])
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
        this.lua_pushinteger = this.withIntegerArgument('lua_pushinteger', null, ['number', 'number'])
        this.lua_pushcclosure = this.cwrap('lua_pushcclosure', null, ['number', 'number', 'number'])
        this.lua_pushboolean = this.cwrap('lua_pushboolean', null, ['number', 'number'])
        this.lua_pushlightuserdata = this.cwrap('lua_pushlightuserdata', null, ['number', 'number'])
        this.lua_pushthread = this.cwrap('lua_pushthread', 'number', ['number'])
        this.lua_getglobal = this.cwrap('lua_getglobal', 'number', ['number', 'string'])
        this.lua_gettable = this.cwrap('lua_gettable', 'number', ['number', 'number'])
        this.lua_getfield = this.cwrap('lua_getfield', 'number', ['number', 'number', 'string'])
        this.lua_geti = this.withIntegerArgument('lua_geti', 'number', ['number', 'number', 'number'])
        this.lua_rawget = this.cwrap('lua_rawget', 'number', ['number', 'number'])
        this.lua_rawgeti = this.withIntegerArgument('lua_rawgeti', 'number', ['number', 'number', 'number'])
        this.lua_rawgetp = this.cwrap('lua_rawgetp', 'number', ['number', 'number', 'number'])
        this.lua_createtable = this.cwrap('lua_createtable', null, ['number', 'number', 'number'])
        this.lua_newuserdatauv = this.cwrap('lua_newuserdatauv', 'number', ['number', 'number', 'number'])
        this.lua_getmetatable = this.cwrap('lua_getmetatable', 'number', ['number', 'number'])
        this.lua_getiuservalue = this.cwrap('lua_getiuservalue', 'number', ['number', 'number', 'number'])
        this.lua_setglobal = this.cwrap('lua_setglobal', null, ['number', 'string'])
        this.lua_settable = this.cwrap('lua_settable', null, ['number', 'number'])
        this.lua_setfield = this.cwrap('lua_setfield', null, ['number', 'number', 'string'])
        this.lua_seti = this.withIntegerArgument('lua_seti', null, ['number', 'number', 'number'])
        this.lua_rawset = this.cwrap('lua_rawset', null, ['number', 'number'])
        this.lua_rawseti = this.withIntegerArgument('lua_rawseti', null, ['number', 'number', 'number'])
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
        this.wasmoon_set_await_hook = this.cwrap('wasmoon_set_await_hook', null, ['number'])
        this.wasmoon_push_jsfunction = this.cwrap('wasmoon_push_jsfunction', null, ['number', 'number'])
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
        // lua_gc is variadic: the wasm32 ABI passes `...` as a pointer to the arguments laid out
        // in memory, and every argument lua_gc reads is 32 bit.
        this.rawLuaGc = this.cwrap('lua_gc', 'number', ['number', 'number', 'number'])
        this.lua_gc = (L, what, a, b) => {
            this.writePointer(this.gcArgsScratch, a)
            this.writePointer(this.gcArgsScratch + PointerSize, b)
            return this.rawLuaGc(L, what, this.gcArgsScratch)
        }

        this.rawLuaToLString = this.cwrap('lua_tolstring', 'number', ['number', 'number', 'number'])
        this.rawLuaLToLString = this.cwrap('luaL_tolstring', 'number', ['number', 'number', 'number'])
        this.rawLuaPushString = this.cwrap('lua_pushstring', 'number', ['number', 'number'])
        this.lua_pushlstring = this.cwrap('lua_pushlstring', 'number', ['number', 'number', 'number'])

        this.sizeScratch = module._malloc(PointerSize)
        this.resultCountScratch = module._malloc(PointerSize)
        this.gcArgsScratch = module._malloc(2 * PointerSize)
        // Never read or written, only compared: it exists so that the address is ours alone.
        this.interruptToken = module._malloc(1)
        if (!this.sizeScratch || !this.resultCountScratch || !this.gcArgsScratch || !this.interruptToken) {
            throw new Error('failed to allocate the scratch buffers for C out parameters')
        }

        // Captured while no Lua is running, so it is the top of the C stack in JS land.
        this.mainStackPointer = this.stackSave()
        this.useJspi = this.jspiSupported && this.asyncEngine !== 'yield'
        if (this.useJspi) {
            this.installAwaitHook()
        }
    }

    /** {@link promising}-wrapped `lua_resume`, built on first use and kept. */
    public promisingResume(): (L: LuaAddress, from: LuaAddress | null, narg: number, nres: number) => Promise<LuaReturn> {
        this.promisingResumeFunction ??= this.promising(this.lua_resume as (...args: any[]) => LuaReturn)
        return this.promisingResumeFunction
    }

    /**
     * Installs the single C await hook every JS function closure suspends through under JSPI. It
     * awaits the promise the {@link pendingSuspend} slot was left holding, having first freed this
     * run's slice of the shared linear-memory C stack so other runs can use it while parked, then
     * restores that slice and marshals the settled value back before returning into Lua.
     */
    private installAwaitHook(): void {
        this.awaitHookPointer = this.emscripten.addFunction(
            // The C signature passes the running coroutine, but it is always the one the await
            // parked on, which the pendingSuspend marshallers already hold; nothing here needs it.
            this.suspending(async (): Promise<number> => {
                const suspend = this.pendingSuspend
                this.pendingSuspend = undefined
                if (suspend === undefined) {
                    throw new Error('the JSPI await hook ran with no pending suspend')
                }

                const stackPointer = this.stackSave()
                const savedStack = this.heap.slice(stackPointer, this.mainStackPointer)
                this.stackRestore(this.mainStackPointer)

                const outcome = await settleOrInterrupt(suspend.promise, suspend.signal, suspend.deadline)

                // The state was closed while parked: lua_close has freed the stack this would
                // resume into, so stay suspended forever rather than resume into freed memory. The
                // run itself was already rejected by runJspi's close race.
                if (suspend.isClosed()) {
                    await new Promise<never>(() => undefined)
                }

                // Back on this run's stack: put its frames back before touching Lua, and mark the
                // stack promising again for any further await this resume reaches.
                this.heap.set(savedStack, stackPointer)
                this.stackRestore(stackPointer)
                this.stackCanSuspend = true

                if (outcome.interrupted) {
                    return suspend.onInterrupt()
                }
                return outcome.resolved ? suspend.onResolve(outcome.value) : suspend.onReject(outcome.error)
            }),
            'ii',
        )
        this.wasmoon_set_await_hook(this.awaitHookPointer)
    }

    /**
     * Exposes a host directory in the in-memory filesystem, the way {@link LuaModuleOptions.mounts}
     * does at load time and with the same checks. Node only, and only with `fs: 'memory'`.
     */
    public mount(virtualPath: string, hostPath: string): void {
        if (this.fs === 'host') {
            throw new Error(MOUNTS_NEED_MEMORY_FS)
        }

        const mount = resolveMount(virtualPath, hostPath)
        assertMountFits(this.mounts, mount)

        const fs = this.emscripten.FS
        fs.mkdirTree(mount.virtualPath)
        fs.mount(fs.filesystems.NODEFS, { root: mount.hostPath }, mount.virtualPath)
        this.mounts.push(mount)
    }

    /** Detaches a {@link LuaModule.mount}, leaving its mount point behind as an empty directory. */
    public unmount(virtualPath: string): void {
        this.emscripten.FS.unmount(virtualPath)
        // Dropped only once Emscripten agrees it was a mount point, so a failed unmount leaves the
        // bookkeeping matching what is actually mounted.
        const index = this.mounts.findIndex((mount) => mount.virtualPath === virtualPath)
        if (index >= 0) {
            this.mounts.splice(index, 1)
        }
    }

    /**
     * Bytes that aren't valid UTF-8 are replaced with U+FFFD. Use {@link lua_tobytes} when the
     * value holds arbitrary binary data (`string.dump`, `string.pack`, ciphertext, ...).
     */
    public lua_tolstring(L: LuaAddress, idx: number, len: number | null = null): string {
        return this.toLString(this.rawLuaToLString, L, idx, len)
    }

    /** Goes through the `__tostring` metamethod, which leaves the result on the stack. */
    public luaL_tolstring(L: LuaAddress, idx: number, len: number | null = null): string {
        return this.toLString(this.rawLuaLToLString, L, idx, len)
    }

    public lua_tobytes(L: LuaAddress, idx: number): Uint8Array | undefined {
        const pointer = this.rawLuaToLString(L, idx, this.sizeScratch)
        if (!pointer) {
            return undefined
        }
        // Copied, because the caller may outlive the next heap growth.
        return this.heap.slice(pointer, pointer + this.readPointer(this.sizeScratch))
    }

    /** A number is a pointer to a NUL-terminated C string, and `null` pushes nil, as in C. */
    public lua_pushstring(L: LuaAddress, s: string | number | null): void {
        if (s === null || s === undefined) {
            this.lua_pushnil(L)
        } else if (typeof s === 'number') {
            this.rawLuaPushString(L, s)
        } else if (s.length === 0) {
            this.lua_pushlstring(L, 0, 0)
        } else {
            const capacity = s.length * MAX_UTF8_BYTES_PER_CHAR
            const pointer = this.acquireStringBuffer(capacity)
            try {
                this.lua_pushlstring(L, pointer, this.writeString(s, pointer, capacity))
            } finally {
                this.releaseStringBuffer(pointer)
            }
        }
    }

    public lua_pushbytes(L: LuaAddress, bytes: Uint8Array): void {
        const pointer = this.acquireStringBuffer(bytes.length)
        try {
            this.heap.set(bytes, pointer)
            this.lua_pushlstring(L, pointer, bytes.length)
        } finally {
            this.releaseStringBuffer(pointer)
        }
    }

    /**
     * The counterpart to {@link writeString}. A short ASCII string is gathered and built in one
     * `fromCharCode`: Emscripten's own decoder concatenates a character at a time below its
     * TextDecoder threshold, which cost more than the decode itself for the names and keys that
     * make up most reads here. A NUL is an ordinary byte, since the length is already known.
     */
    public readString(pointer: number, length: number): string {
        if (!length) {
            return ''
        }
        const heap = this.heap
        if (length <= INLINE_DECODE_LIMIT) {
            const codes = new Array<number>(length)
            let index = 0
            while (index < length) {
                const code = heap[pointer + index]
                if (code > 0x7f) {
                    break
                }
                codes[index++] = code
            }
            if (index === length) {
                return String.fromCharCode.apply(null, codes)
            }
            // Anything non-ASCII is decoded from the start, the same as the long strings below.
        }
        return textDecoder.decode(heap.subarray(pointer, pointer + length))
    }

    /**
     * Calls `use` with a NUL terminated copy of `value` in wasm memory, valid only for that call.
     * Reuses the shared string buffer, so `use` must not push another string of its own.
     */
    public withCString<T>(value: string, use: (pointer: number, length: number) => T): T {
        // The NUL is not part of the length, but a caller that reads the pointer as a C string
        // (a chunk name, say) needs it there.
        const capacity = value.length * MAX_UTF8_BYTES_PER_CHAR + 1
        const pointer = this.acquireStringBuffer(capacity)
        try {
            const written = this.writeString(value, pointer, capacity - 1)
            this.heap[pointer + written] = 0
            return use(pointer, written)
        } finally {
            this.releaseStringBuffer(pointer)
        }
    }

    /**
     * Encodes `value` at `pointer` and returns the number of bytes written. The counterpart to
     * {@link readString}: short ASCII takes a straight copy, because the subarray view TextEncoder
     * needs costs more than the encoding does at that size.
     */
    private writeString(value: string, pointer: number, capacity: number): number {
        const heap = this.heap
        const length = value.length
        if (length <= INLINE_ENCODE_LIMIT) {
            let index = 0
            while (index < length) {
                const code = value.charCodeAt(index)
                if (code > 0x7f) {
                    break
                }
                heap[pointer + index] = code
                index++
            }
            if (index === length) {
                return length
            }
            // Anything non-ASCII is re-encoded from the start, overwriting what was copied above.
        }

        return textEncoder.encodeInto(value, heap.subarray(pointer, pointer + capacity)).written
    }

    /**
     * The 32 bit word at `pointer`, without going through Emscripten's typed getValue. Also reads
     * the out parameters the C API writes sizes and counts into, which are the same width.
     */
    public readPointer(pointer: number): number {
        return this.emscripten.HEAPU32[pointer >>> 2]
    }

    /** The counterpart to {@link readPointer}. */
    public writePointer(pointer: number, value: number): void {
        this.emscripten.HEAPU32[pointer >>> 2] = value
    }

    /**
     * Whether this runtime can run Lua under JSPI, so an `:await()` can suspend the wasm stack
     * anywhere instead of only at a coroutine boundary. Needs the VM support and a glue built with
     * `SUPPORT_LONGJMP=wasm`, without which a suspend trap fires on the `invoke_*` JS trampolines.
     */
    public readonly jspiSupported: boolean =
        typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function' &&
        typeof (WebAssembly as { promising?: unknown }).promising === 'function'

    /** The current wasm stack pointer, saved so a suspended run's C frames can be restored. */
    public stackSave(): number {
        return this.emscripten.stackSave()
    }

    public stackRestore(pointer: number): void {
        this.emscripten.stackRestore(pointer)
    }

    /** Wraps a wasm export so calling it runs Lua on a JSPI stack that can suspend. */
    public promising<T extends (...args: any[]) => any>(fn: T): (...args: Parameters<T>) => Promise<ReturnType<T>> {
        return (WebAssembly as unknown as { promising: (fn: T) => (...args: Parameters<T>) => Promise<ReturnType<T>> }).promising(fn)
    }

    /** Wraps a JS callback so a Lua import can suspend the JSPI stack while it awaits. */
    public suspending(fn: (...args: any[]) => any): any {
        return new (WebAssembly as unknown as { Suspending: new (fn: (...args: any[]) => any) => unknown }).Suspending(fn)
    }

    /**
     * Puts a JS callback in the indirect function table and returns the pointer Lua calls it
     * through. Release it with {@link removeFunction}.
     *
     * A plain JS function cannot go into the table, so it has to be wrapped by a wasm module that
     * imports and re-exports it. Emscripten's addFunction builds that module per callback, after
     * first provoking a TypeError to discover it is needed. The module depends only on the
     * signature, so compiling it once per signature is most of the cost: a state installs five
     * callbacks, which was over half of what creating one cost.
     *
     * Each call takes a slot of its own. Unlike Emscripten's, these are not deduplicated by
     * callback identity, so registering the same callback twice needs releasing twice.
     */
    public addFunction(callback: (...args: any[]) => any, signature: string): number {
        let trampoline = this.trampolineModules.get(signature)
        if (trampoline === undefined) {
            trampoline = buildTrampolineModule(signature)
            this.trampolineModules.set(signature, trampoline)
        }

        const wrapped = new WebAssembly.Instance(trampoline, { e: { f: callback } }).exports.f as (...args: any[]) => any
        // Already a wasm function, so this now takes Emscripten's slot bookkeeping and nothing else.
        return this.emscripten.addFunction(wrapped, signature)
    }

    /** Frees a table slot taken by {@link addFunction}. */
    public removeFunction(pointer: number): void {
        this.emscripten.removeFunction(pointer)
    }

    /**
     * The `__gc` handler for a userdata holding a reference index, which is what every reference
     * holding type extension puts on its metatable and the same code for each of them. One per
     * module rather than one per extension per state: each takes a trampoline of its own from
     * {@link addFunction}, and those were a fifth of what creating a state cost. Owned by the
     * module, so it is never removed.
     */
    public referenceGcFunction(): number {
        this.referenceGcPointer ??= this.addFunction((L: LuaAddress): number => {
            // Only a userdata pushed by LuaTypeExtension holds a reference index, and those are
            // exactly one pointer wide. The check stands in for the metatable name one a handler
            // built per extension can make: it rules out the io library's stream handles, the one
            // other userdata Lua code can reach and put one of these metatables on through
            // debug.setmetatable, which would otherwise be read as an index and unreferenced.
            const userdata = this.lua_touserdata(L, 1)
            if (userdata && this.lua_rawlen(L, 1) === BigInt(PointerSize)) {
                this.unref(this.readPointer(userdata))
            }
            return LuaReturn.Ok
        }, 'ii')
        return this.referenceGcPointer
    }

    private toLString(raw: (L: LuaAddress, idx: number, len: number) => number, L: LuaAddress, idx: number, len: number | null): string {
        const lengthPointer = len ?? this.sizeScratch
        const pointer = raw(L, idx, lengthPointer)
        return pointer ? this.readString(pointer, this.readPointer(lengthPointer)) : ''
    }

    public lua_remove(luaState: LuaAddress, index: number): void {
        this.lua_rotate(luaState, index, -1)
        this.lua_pop(luaState, 1)
    }

    public lua_pop(luaState: LuaAddress, count: number): void {
        this.lua_settop(luaState, -count - 1)
    }

    public luaL_getmetatable(luaState: LuaAddress, name: string): LuaType {
        return this.lua_getfield(luaState, LUA_REGISTRYINDEX, name)
    }

    public lua_yield(luaState: LuaAddress, count: number): number {
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
            // Dropping the map entry too, both to release the value and to keep the invariant the
            // index allocation above relies on: every index below the high water mark is either
            // live in referenceMap or waiting in availableReferences, never neither and never both.
            this.referenceMap.delete(index)
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

    public getRef(index: number): unknown {
        return this.referenceMap.get(index)
    }

    /**
     * Pushes a fresh userdata holding a reference to `target`: the box every reference carrying
     * type extension puts a JS value in. The layout, a single pointer sized slot holding the
     * reference index, is known here, in {@link getReferenceBox} and in the `__gc` handler
     * {@link referenceGcFunction} builds, and nowhere else.
     *
     * The reference is the caller's to release until the box has a metatable carrying that `__gc`,
     * which is what hands ownership to Lua.
     * @returns the reference index, which also serves as the box's identity in a push cache.
     */
    public pushReferenceBox(L: LuaAddress, target: unknown): number {
        const index = this.ref(target)
        const userDataPointer = this.lua_newuserdatauv(L, PointerSize, 0)
        this.writePointer(userDataPointer, index)
        return index
    }

    /**
     * The JS value boxed in the userdata at `index`, or undefined when nothing is boxed there. With
     * a `metatableName` only a userdata carrying that metatable counts; without one the caller has
     * already established what it is looking at, so the check and the name it marshals are skipped.
     */
    public getReferenceBox(L: LuaAddress, index: number, metatableName?: string): unknown {
        const userDataPointer = metatableName === undefined ? this.lua_touserdata(L, index) : this.luaL_testudata(L, index, metatableName)
        return userDataPointer ? this.referenceMap.get(this.readPointer(userDataPointer)) : undefined
    }

    /** The index {@link ref} already holds for `data`, without taking a count, or undefined. */
    public getRefIndex(data: unknown): number | undefined {
        return this.referenceTracker.get(data)?.index
    }

    // This is needed for some tests
    public getLastRefIndex(): number | undefined {
        return this.lastRefIndex
    }

    public printRefs(log = console.log): void {
        for (const [key, value] of this.referenceMap.entries()) {
            log(key, value)
        }
    }

    // Never cache this: ALLOW_MEMORY_GROWTH swaps the underlying buffer when the heap grows, and
    // Emscripten reassigns HEAPU8 to match.
    private get heap(): Uint8Array {
        return this.emscripten.HEAPU8
    }

    private acquireStringBuffer(size: number): number {
        if (size > REUSABLE_STRING_BUFFER_LIMIT) {
            const pointer = this.emscripten._malloc(size)
            if (!pointer) {
                throw new Error(`failed to allocate ${size} bytes for a string`)
            }
            return pointer
        }

        if (!this.stringBuffer) {
            this.stringBuffer = this.emscripten._malloc(REUSABLE_STRING_BUFFER_LIMIT)
            if (!this.stringBuffer) {
                throw new Error(`failed to allocate ${REUSABLE_STRING_BUFFER_LIMIT} bytes for the string buffer`)
            }
        }

        return this.stringBuffer
    }

    private releaseStringBuffer(pointer: number): void {
        if (pointer !== this.stringBuffer) {
            this.emscripten._free(pointer)
        }
    }

    /**
     * A binding whose last argument is a `lua_Integer`, taking either a BigInt or a number. The
     * BigInt goes to the C API as it is; a number, which has to be a safe integer, goes to the
     * double taking twin of the same name in src/native/wasmoon.c, saving the BigInt conversion on
     * every call. The integer is the last argument of each of these.
     */
    private withIntegerArgument(
        name: string,
        returnType: Emscripten.JSType | null,
        argTypes: Emscripten.JSType[],
    ): (...args: any[]) => any {
        const bigintBinding = this.cwrap(name, returnType, argTypes)
        const numberBinding = this.cwrap(name.replace('lua_', 'wasmoon_'), returnType, argTypes)
        const integerLast = argTypes.length === 2
        if (!integerLast && argTypes.length !== 3) {
            throw new Error(`withIntegerArgument only covers arities 2 and 3, not ${argTypes.length}`)
        }

        return (a: any, b: any, c?: any): any => {
            const n = integerLast ? b : c
            if (typeof n === 'bigint') {
                return bigintBinding(a, b, c)
            }
            if (!Number.isSafeInteger(n)) {
                throw new RangeError(`${n} is not a safe integer; pass a BigInt for the full lua_Integer range`)
            }
            return numberBinding(a, b, c)
        }
    }

    private cwrap(
        name: string,
        returnType: Emscripten.JSType | null,
        argTypes: Array<Emscripten.JSType | 'string|number'>,
    ): (...args: any[]) => any {
        const raw = (this.emscripten as unknown as Record<string, (...args: any[]) => any>)[`_${name}`]
        if (typeof raw !== 'function') {
            throw new Error(`the wasm module does not export '${name}'`)
        }

        // Emscripten's own cwrap specializes exactly this case and nothing else, so it is inlined
        // here rather than exported: a signature that needs nothing marshalled in either direction
        // is just the wasm export.
        if (argTypes.every((argType) => argType === 'number') && returnType !== 'string') {
            return raw
        }

        // Everything else, C string arguments included, goes through one hand rolled wrapper, since
        // upstream would fall back to ccall -- which rebuilds its converter table, argument array
        // and return handler on every call. That is most of the cost of the small C API functions,
        // and these are hot: metatable names, globals, table fields.
        return this.wrapWithStringArguments(raw, returnType, argTypes)
    }

    /**
     * Rest arguments and a spread call would land on every C API call that takes a name, so the
     * arguments are named and both the argument positions and the arity are unrolled. Which slots
     * hold a C string is fixed when the binding is wrapped, so it is not worked out per call.
     */
    private wrapWithStringArguments(
        raw: (...args: any[]) => any,
        returnType: Emscripten.JSType | null,
        argTypes: Array<Emscripten.JSType | 'string|number'>,
    ): (...args: any[]) => any {
        const emscripten = this.emscripten
        const arity = argTypes.length
        if (arity < 2 || arity > 5) {
            throw new Error(`wrapWithStringArguments only unrolls arities 2 to 5, not ${arity}`)
        }
        if (argTypes[0] !== 'number') {
            // Every binding takes the lua_State there, so that slot is not unrolled below.
            throw new Error('wrapWithStringArguments does not marshal the first argument')
        }

        const returnsString = returnType === 'string'
        // `string` is a fixed name worth caching; `string|number` is a chunk of source or another
        // one-off, which would fill the cache and push the names that dominate these calls out of it.
        const [, s1, s2, s3, s4] = argTypes.map((argType) =>
            argType === 'string' ? StringArgument.Cached : argType === 'string|number' ? StringArgument.Uncached : StringArgument.None,
        )

        return (a?: any, b?: any, c?: any, d?: any, e?: any): any => {
            // Only an argument that misses the cache needs scratch space, and the fixed names that
            // dominate these calls all hit it, so the stack is only touched when it is used.
            let stack = 0
            // Lazily, so the common path where nothing is long enough to need the heap allocates
            // nothing of its own.
            let owned: number[] | undefined
            try {
                let pointer: number
                if (s1) {
                    if ((pointer = this.toCString(b, s1)) >= 0) {
                        b = pointer
                    } else if (b.length > STACK_STRING_LIMIT) {
                        b = this.ownCString(b, (owned ??= []))
                    } else {
                        stack ||= emscripten.stackSave()
                        b = emscripten.stringToUTF8OnStack(b)
                    }
                }
                if (s2) {
                    if ((pointer = this.toCString(c, s2)) >= 0) {
                        c = pointer
                    } else if (c.length > STACK_STRING_LIMIT) {
                        c = this.ownCString(c, (owned ??= []))
                    } else {
                        stack ||= emscripten.stackSave()
                        c = emscripten.stringToUTF8OnStack(c)
                    }
                }
                if (s3) {
                    if ((pointer = this.toCString(d, s3)) >= 0) {
                        d = pointer
                    } else if (d.length > STACK_STRING_LIMIT) {
                        d = this.ownCString(d, (owned ??= []))
                    } else {
                        stack ||= emscripten.stackSave()
                        d = emscripten.stringToUTF8OnStack(d)
                    }
                }
                if (s4) {
                    if ((pointer = this.toCString(e, s4)) >= 0) {
                        e = pointer
                    } else if (e.length > STACK_STRING_LIMIT) {
                        e = this.ownCString(e, (owned ??= []))
                    } else {
                        stack ||= emscripten.stackSave()
                        e = emscripten.stringToUTF8OnStack(e)
                    }
                }

                const result = arity === 2 ? raw(a, b) : arity === 3 ? raw(a, b, c) : arity === 4 ? raw(a, b, c, d) : raw(a, b, c, d, e)
                return returnsString ? emscripten.UTF8ToString(result) : result
            } finally {
                if (stack) {
                    emscripten.stackRestore(stack)
                }
                if (owned) {
                    // Only reached by a binding Lua copies the string in, which is what lets these be
                    // freed as the call returns.
                    for (const allocated of owned) {
                        emscripten._free(allocated)
                    }
                }
            }
        }
    }

    /**
     * A string too long to put on the wasm stack, on the heap instead and recorded so the call that
     * marshalled it can free it as it returns.
     */
    private ownCString(value: string, owned: number[]): number {
        const pointer = this.emscripten.stringToNewUTF8(value)
        owned.push(pointer)
        return pointer
    }

    /**
     * The C string pointer for a marshalled argument, or -1 when the caller has to put it in
     * scratch space instead. Cached pointers are kept for the lifetime of the module, so they stay
     * valid across the reentrant calls a metamethod can make while one of them is still in flight.
     */
    private toCString(value: unknown, mode: StringArgument): number {
        // A nullish argument is a null pointer rather than the text "null", as it was under ccall. A
        // number is already one, which is what the `string|number` bindings pass.
        if (value === null || value === undefined) {
            return 0
        }
        if (typeof value === 'number') {
            return value
        }

        // Checked before the lookup, because hashing a long string costs more than the call saves.
        const text = value as string
        if (mode === StringArgument.Uncached || text.length > C_STRING_CACHE_MAX_LENGTH) {
            return -1
        }
        const cached = this.cStringCache.get(text)
        if (cached !== undefined) {
            return cached
        }
        if (this.cStringCache.size >= C_STRING_CACHE_LIMIT) {
            return -1
        }

        const pointer = this.emscripten.stringToNewUTF8(text)
        this.cStringCache.set(text, pointer)
        return pointer
    }
}

/**
 * The callback is asked for more input whenever the C side runs out, and each call satisfies a
 * single read: once the returned text is consumed the read ends, so the next one asks again
 * instead of blocking for a whole buffer worth of input. An empty string (or nothing at all)
 * signals EOF.
 */
function createInputReader(reader?: () => string | null | undefined): (() => number | null) | null {
    if (!reader) {
        return null
    }

    let pending: Uint8Array | undefined
    let offset = 0

    return (): number | null => {
        if (pending === undefined) {
            const input = reader() ?? ''
            if (typeof input !== 'string') {
                throw new Error('stdin must return a string')
            }
            // Not NUL terminated, so a NUL inside the input stays a regular byte.
            pending = textEncoder.encode(input)
            offset = 0
        }

        if (offset >= pending.length) {
            // Ends the current read instead of asking for more, and makes the next one start over.
            pending = undefined
            return null
        }

        return pending[offset++]
    }
}

// Emscripten hands output over one byte at a time, so it has to be reassembled before it can be
// decoded. Doubles from here as lines get longer.
const INITIAL_OUTPUT_CAPACITY = 256
// Grown past this the buffer is dropped back to it once the line is out, rather than kept for the
// module's lifetime: a single huge `io.write` would otherwise retain its whole capacity forever,
// twice over for a runtime with both stdout and stderr. Dropping all the way back to the initial
// capacity instead would make a script that writes long lines in a loop regrow from 256 bytes on
// every one.
const MAX_RETAINED_OUTPUT_CAPACITY = 64 * 1024

function createOutputWriter(writer?: (content: string) => void): ((charCode: number | null) => void) | null {
    if (!writer) {
        return null
    }

    // Its own decoder, because a flush in the middle of a line can cut a multi byte character in
    // half and the rest of it only arrives later.
    const decoder = new TextDecoder()
    let buffer = new Uint8Array(INITIAL_OUTPUT_CAPACITY)
    let length = 0
    let flushScheduled = false

    const emit = (endOfLine: boolean): void => {
        // A CR right before the line break is part of the terminator, but one anywhere else is
        // content and has to survive.
        if (endOfLine && length > 0 && buffer[length - 1] === 13) {
            length--
        }
        // Only the end of a line is a character boundary for sure, so anything else leaves a
        // dangling character in the decoder to be completed by the next flush.
        const content = decoder.decode(buffer.subarray(0, length), { stream: !endOfLine })
        length = 0
        if (buffer.length > MAX_RETAINED_OUTPUT_CAPACITY) {
            buffer = new Uint8Array(MAX_RETAINED_OUTPUT_CAPACITY)
        }
        // An empty line is worth reporting, an incomplete character is not.
        if (endOfLine || content.length > 0) {
            writer(content)
        }
    }

    return (charCode: number | null): void => {
        if (charCode === null || charCode === 10) {
            emit(true)
            return
        }

        if (length === buffer.length) {
            const grown = new Uint8Array(buffer.length * 2)
            grown.set(buffer)
            buffer = grown
        }
        buffer[length++] = charCode

        if (!flushScheduled) {
            flushScheduled = true
            // Output that never ends in a newline (`io.write` without one, a prompt, ...) would
            // otherwise sit here forever. Flushing on a microtask keeps it in the same line as
            // whatever else the current run writes, while still handing it over once Lua is done.
            queueMicrotask(() => {
                flushScheduled = false
                if (length > 0) {
                    emit(false)
                }
            })
        }
    }
}
