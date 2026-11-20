// The types below are `@types/emscripten`'s ambient globals. They only resolve for a consumer who
// lists "emscripten" in their own tsconfig `types`, so utils/reference-types.js puts a
// `/// <reference types="emscripten" />` at the top of the emitted declarations to cover everyone
// else. tsc drops the directive when it is written here, hence the build step.
import LuaBindings from './bindings.gen'
import { canSuspend, limitError, type PendingSuspend, settleOrInterrupt, type SettleOutcome, yieldToEventLoop } from './async'
import type Thread from './thread'
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
 * - `'none'`: no filesystem at all, for a smaller download. Opening, removing or renaming a file
 *   fails, so does `require` of anything but a preloaded module, and the runtime's file methods
 *   throw. Stdio still works, through the stdin, stdout and stderr options.
 */
export type LuaFileSystem = 'memory' | 'host' | 'none'

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
    // FS, NODEFS and PATH are missing from the glue for `fs: 'none'`.
    FS: typeof FS
    // Exported by the build, since Emscripten 7 no longer hangs the backends off FS.filesystems.
    NODEFS: Emscripten.FileSystemType
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
    _wasmoon_isarray: (L: LuaAddress, index: number) => number
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
// The short strings read out of Lua are mostly the same few names over and over -- table keys,
// globals, metamethod names -- so the string built for a run of bytes is kept and handed back the
// next time those bytes are read, which also gives the property lookups it usually feeds the
// same, already internalized string. Direct mapped on a hash of the bytes; a power of two.
const DECODED_STRING_CACHE_SIZE = 32

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

/** A {@link LuaModuleOptions.mounts} entry with both sides checked, ready for `FS.mount`. */
interface ResolvedMount {
    /** Absolute, with no trailing slash and no `.` or `..` in it. */
    virtualPath: string
    /** Absolute host path of a directory that exists. */
    hostPath: string
}

// The only rule about `mounts` that is not about a single mount, so both the option and the method
// report it with one voice.
const MOUNTS_NEED_MEMORY_FS = `mounts belong to fs: 'memory'; with 'host' every host path is already reachable, and 'none' has nothing to mount into`

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

function mountHostDirectory(emscripten: LuaEmscriptenModule, { virtualPath, hostPath }: ResolvedMount): void {
    emscripten.FS.mkdirTree(virtualPath)
    emscripten.FS.mount(emscripten.NODEFS, { root: hostPath }, virtualPath)
}

/** Everything the wasm module needs before it starts, and nothing that outlives that. */
interface PreRunConfig {
    env: EnvironmentVariables | undefined
    mounts: readonly ResolvedMount[]
    stdin?: LuaModuleOptions['stdin']
    stdout?: LuaModuleOptions['stdout']
    stderr?: LuaModuleOptions['stderr']
}

interface ReferenceEntry {
    value: unknown
    count: number
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
        for (const mount of config.mounts) {
            mountHostDirectory(initializedModule, mount)
        }

        if (config.stdin || config.stdout || config.stderr) {
            initializedModule.FS.init(createInputReader(config.stdin), createOutputWriter(config.stdout), createOutputWriter(config.stderr))
        }
    }
}

export default class LuaModule extends LuaBindings {
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
        if (fs !== 'memory' && mountEntries.length > 0) {
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

        // Without a filesystem there is no FS.init to hand stdio to, so that glue takes it directly,
        // with the defaults the other glues fall back to when given nothing.
        const stdio =
            fs === 'none'
                ? {
                      stdin: createInputReader(opts.stdin),
                      stdout: createOutputWriter(opts.stdout ?? ((line) => console.log(line))),
                      stderr: createOutputWriter(opts.stderr ?? printErr),
                  }
                : {}
        const preRun = createPreRun({
            env: opts.env,
            mounts,
            ...(fs === 'none' ? {} : { stdin: opts.stdin, stdout: opts.stdout, stderr: opts.stderr }),
        })

        // Three glues over the one wasm, differing only in their filesystem (see
        // utils/build-wasm.sh). Each is a chunk of its own, imported on demand, so a load only
        // downloads the one it asked for -- and a browser bundle never loads the host one, which
        // throws outside Node.
        const init = (
            fs === 'host'
                ? await import('../build/host/glue.js')
                : fs === 'none'
                  ? await import('../build/none/glue.js')
                  : await import('../build/glue.js')
        ).default
        if (typeof init !== 'function') {
            // The `browser` field points bundlers at a stub, since the glue only runs under Node.
            throw new Error(`fs: 'host' needs glue-host.js, which the bundle replaced with a stub because it targets the browser`)
        }

        const load = async (wasmFile?: string): Promise<LuaModule> => {
            return new LuaModule(
                await init({ ...(wasmFile === undefined ? {} : { locateFile: () => wasmFile }), preRun, printErr, ...stdio }),
                opts.onWarn,
                fs,
                mounts,
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

    /** The handler passed to {@link LuaModule.initialize}, which states created on it inherit. */
    public readonly onWarn: LuaWarnHandler | undefined
    /** Which filesystem this module was loaded with, as {@link LuaModuleOptions.fs}. */
    public readonly fs: LuaFileSystem

    declare public wasmoon_set_await_hook: (hook: number, resumeHook: number) => void
    declare public wasmoon_push_jsfunction: (L: LuaAddress, callHook: number) => void

    /** The mounts that are live, so a later one can be checked against them. */
    private readonly mounts: ResolvedMount[]

    private readonly cStringCache = new Map<string, number>()
    private readonly trampolineModules = new Map<string, WebAssembly.Module>()
    // A live slot holds a value and its holder count; a released slot holds the negated next free
    // index. Combining them keeps just one array slot per hole when a high live index prevents
    // trimming, instead of retaining separate value and count arrays. Records exist only while
    // live. External indices are one-based so a reference box never carries a null pointer.
    private readonly references: (ReferenceEntry | number)[] = []
    private firstFreeReference = 0
    private highestReference = 0
    private readonly referenceIndexes = new WeakMap<WeakKey, number>()
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
     * Pushing the error itself is what this replaced. That allocates a userdata, where light
     * userdata allocates nothing, and the hook fires at an arbitrary instruction, including under a
     * `memory.max` tight enough that a real userdata would fail and report a memory error in place
     * of the limit that was actually hit.
     */
    public readonly interruptToken: number
    /**
     * The wasm stack pointer while control is in JS with none of our wasm frames below, captured
     * once. A suspension frees the C stack from the run's frontier up to here, and restores it
     * before resuming. See {@link installAwaitHook}.
     */
    public readonly mainStackPointer: number
    /** Whether the platform has JSPI. Without it an `:await()` is an error and everything else works. */
    public readonly jspiSupported: boolean
    /** `lua_resume` wrapped in `WebAssembly.promising`, or the plain export where there is no JSPI. */
    public readonly suspendableResume: (...args: Parameters<LuaModule['lua_resume']>) => Promise<LuaReturn> | LuaReturn
    /**
     * Set true only while a promising resume is the innermost driver on the stack, so an `:await()`
     * knows a suspend would reach a promising boundary. A synchronous entry point (doStringSync, a
     * JS→Lua callback) sets it false around its own call, so an await there raises an error instead
     * of trapping.
     */
    public stackCanSuspend = false
    /**
     * Read synchronously by the await hook right after the await closure returns, so a single slot
     * is reentrancy safe.
     */
    public pendingSuspend: PendingSuspend | undefined
    /** The innermost Lua driver. Installed only while entering or continuing Lua. */
    public activeRun: Thread | undefined
    private asyncSteps = 0

    /** Amortized fairness across all runs; the common step allocates nothing. */
    public scheduleAsync(): Promise<void> | undefined {
        if (++this.asyncSteps < 256) {
            return undefined
        }
        this.asyncSteps = 0
        return yieldToEventLoop()
    }
    private stringBuffer = 0
    // Initialized together on the first short ASCII read. Numeric-only runtimes need no cache.
    // Empty slots hold '', which no non-empty read can match, under a hash of 0.
    private decodedStrings: string[] | undefined
    private decodedStringHashes!: Int32Array
    // The hash last missed in each slot, so a string is kept only once it has been read twice.
    private candidateStringHashes!: Int32Array
    /** Built on first use by {@link referenceGcFunction}, then kept for the module's lifetime. */
    private referenceGcPointer: number | undefined

    public constructor(
        module: LuaEmscriptenModule,
        onWarn?: LuaWarnHandler,
        fs: LuaFileSystem = 'memory',
        mounts: readonly ResolvedMount[] = [],
    ) {
        // Binds the Lua C API, which is generated from the headers: see utils/create-bindings.js.
        super(module)
        this.onWarn = onWarn
        this.fs = fs
        this.mounts = [...mounts]

        this.rawLuaGc = this.exported('lua_gc')
        this.rawLuaToLString = this.exported('lua_tolstring')
        this.rawLuaLToLString = this.exported('luaL_tolstring')
        this.rawLuaPushString = this.exported('lua_pushstring')
        this.wasmoon_set_await_hook = this.exported('wasmoon_set_await_hook')
        this.wasmoon_push_jsfunction = this.exported('wasmoon_push_jsfunction')

        this.sizeScratch = module._malloc(PointerSize)
        this.resultCountScratch = module._malloc(PointerSize)
        this.gcArgsScratch = module._malloc(2 * PointerSize)
        // Never read or written, only compared: it exists so that the address is ours alone.
        this.interruptToken = module._malloc(1)
        if (!this.sizeScratch || !this.resultCountScratch || !this.gcArgsScratch || !this.interruptToken) {
            throw new Error('failed to allocate the scratch buffers for C out parameters')
        }

        this.mainStackPointer = this.stackSave()
        this.jspiSupported = canSuspend()
        this.suspendableResume = this.jspiSupported ? WebAssembly.promising(this.lua_resume) : this.lua_resume
        if (this.jspiSupported) {
            this.installAwaitHook()
        }
    }

    /**
     * Saves the linear-memory stack while awaiting, then restores it in a synchronous C hook.
     * Restoring inside the async hook leaves a microtask gap before Wasm resumes: another ready
     * run could overwrite the saved frames in that gap. The await returns a reference to its
     * restore callback instead, which the C trampoline invokes immediately after resumption.
     */
    private installAwaitHook(): void {
        const resumes = new Map<number, () => number>()
        let nextReference = 0
        const awaitHook = this.emscripten.addFunction(
            new WebAssembly.Suspending(async (): Promise<number> => {
                const suspend = this.pendingSuspend
                this.pendingSuspend = undefined
                if (suspend === undefined) {
                    throw new Error('the await hook ran with no pending suspend')
                }

                const stackPointer = this.stackSave()
                const savedStack = this.heap.slice(stackPointer, this.mainStackPointer)
                this.stackRestore(this.mainStackPointer)

                this.activeRun = undefined
                this.stackCanSuspend = false
                const pause = this.scheduleAsync()
                // Observe rejection before taking the fairness pause.
                let outcome: SettleOutcome
                if (suspend.signal === undefined && suspend.deadline === undefined) {
                    try {
                        outcome = { status: 'fulfilled', value: await suspend.promise }
                    } catch (error) {
                        outcome = { status: 'rejected', error }
                    }
                } else {
                    outcome = await settleOrInterrupt(suspend.promise, suspend.signal, suspend.deadline)
                }
                if (pause) {
                    await pause
                }

                const reference = (nextReference = (nextReference + 1) | 0)
                resumes.set(reference, () => {
                    // No promise reaction can run between this check and entering Lua again.
                    if (suspend.run.isClosed()) {
                        throw new Error('the Lua state is closed')
                    }
                    this.heap.set(savedStack, stackPointer)
                    this.stackRestore(stackPointer)
                    this.stackCanSuspend = true
                    this.activeRun = suspend.run

                    // A fairness pause can outlast the deadline even after settlement.
                    const interrupt = outcome.status === 'interrupted' ? undefined : limitError(suspend.signal, suspend.deadline)
                    return suspend.resume(interrupt ? { status: 'interrupted', error: interrupt } : outcome)
                })
                return reference
            }),
            'ii',
        )
        const resumeHook = this.addFunction((reference: number): number => {
            const resume = resumes.get(reference)!
            resumes.delete(reference)
            return resume()
        }, 'ii')
        this.wasmoon_set_await_hook(awaitHook, resumeHook)
    }

    /**
     * Exposes a host directory in the in-memory filesystem, the way {@link LuaModuleOptions.mounts}
     * does at load time and with the same checks. Node only, and only with `fs: 'memory'`.
     */
    public mount(virtualPath: string, hostPath: string): void {
        if (this.fs !== 'memory') {
            throw new Error(MOUNTS_NEED_MEMORY_FS)
        }

        const mount = resolveMount(virtualPath, hostPath)
        assertMountFits(this.mounts, mount)
        mountHostDirectory(this.emscripten, mount)
        this.mounts.push(mount)
    }

    /** The emscripten module's `FS`, which a module loaded with `fs: 'none'` does not have. */
    public get filesystem(): EmscriptenFS {
        this.assertFilesystem()
        return this.emscripten.FS
    }

    /** The emscripten module's `PATH`, which comes and goes with the filesystem. */
    public get path(): EmscriptenPath {
        this.assertFilesystem()
        return this.emscripten.PATH
    }

    private assertFilesystem(): void {
        if (this.fs === 'none') {
            throw new Error(`there is no filesystem with fs: 'none'; load with 'memory' (the default) or 'host' to have one`)
        }
    }

    /** Detaches a {@link LuaModule.mount}, leaving its mount point behind as an empty directory. */
    public unmount(virtualPath: string): void {
        this.filesystem.unmount(virtualPath)
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
     * The counterpart to {@link writeString}. A short ASCII string is built with one
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
            let hash = length
            let index = 0
            while (index < length) {
                const code = heap[pointer + index]
                if (code > 0x7f) {
                    break
                }
                hash = (Math.imul(hash, 31) + code) | 0
                index++
            }
            if (index === length) {
                let strings = this.decodedStrings
                if (!strings) {
                    this.decodedStringHashes = new Int32Array(DECODED_STRING_CACHE_SIZE)
                    this.candidateStringHashes = new Int32Array(DECODED_STRING_CACHE_SIZE)
                    this.decodedStrings = strings = new Array<string>(DECODED_STRING_CACHE_SIZE).fill('')
                }
                // The bytes are only compared once the whole hash matches, so a miss costs little
                // more than the hashing pass.
                const slot = hash & (DECODED_STRING_CACHE_SIZE - 1)
                if (this.decodedStringHashes[slot] === hash) {
                    const cached = strings[slot]
                    if (cached.length === length && isAsciiAt(cached, heap, pointer)) {
                        return cached
                    }
                }
                const text = decodeAscii(heap, pointer, length)
                // Kept on a repeated hash. A string seen once -- each value of a table being
                // copied, say -- is normally not stored, which spares the store and keeps such a
                // stream from pushing out the names read in between.
                if (this.candidateStringHashes[slot] === hash) {
                    strings[slot] = text
                    this.decodedStringHashes[slot] = hash
                } else {
                    this.candidateStringHashes[slot] = hash
                }
                return text
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

    /** The current wasm stack pointer, saved so a suspended run's C frames can be restored. */
    public stackSave(): number {
        return this.emscripten.stackSave()
    }

    public stackRestore(pointer: number): void {
        this.emscripten.stackRestore(pointer)
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
            // Only a userdata pushed by a type extension holds a reference index, and those are
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

    public lua_resetthread(L: LuaAddress): LuaReturn {
        return this.lua_closethread(L, null)
    }

    /** Deprecated in Lua 5.5; kept as a no-op so the JS API surface stays. */
    public lua_setcstacklimit(_L: LuaAddress, _limit: number): number {
        return 0
    }

    public luaL_openlibs(L: LuaAddress): void {
        this.luaL_openselectedlibs(L, -1, 0)
    }

    /**
     * lua_gc is variadic: the wasm32 ABI passes `...` as a pointer to the arguments laid out in
     * memory, and every argument lua_gc reads is 32 bit.
     */
    public lua_gc(L: LuaAddress, what: number, a: number, b: number): number {
        this.writePointer(this.gcArgsScratch, a)
        this.writePointer(this.gcArgsScratch + PointerSize, b)
        return this.rawLuaGc(L, what, this.gcArgsScratch)
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
        const existing = this.referenceIndexes.get(data as WeakKey)
        if (existing !== undefined) {
            const entry = this.references[existing - 1] as ReferenceEntry
            entry.count++
            return existing
        }

        // The slot is only taken once the WeakMap has accepted the value: it rejects one that cannot
        // be held weakly (a primitive) with a TypeError, which must consume nothing.
        const index = this.firstFreeReference || this.references.length + 1
        this.referenceIndexes.set(data as WeakKey, index)
        if (index === this.firstFreeReference) {
            this.firstFreeReference = -(this.references[index - 1] as number)
        }
        this.references[index - 1] = { value: data, count: 1 }
        if (index > this.highestReference) {
            this.highestReference = index
        }

        this.lastRefIndex = index

        return index
    }

    public unref(index: number): void {
        const entry = this.references[index - 1]
        if (typeof entry !== 'object') {
            return
        }
        if (--entry.count > 0) {
            return
        }

        this.referenceIndexes.delete(entry.value as WeakKey)
        this.references[index - 1] = 0 - this.firstFreeReference
        this.firstFreeReference = index
        if (index === this.highestReference) {
            while (this.highestReference > 0 && typeof this.references[this.highestReference - 1] === 'number') {
                this.highestReference--
            }
            if (this.references.length > 256 && this.highestReference < this.references.length / 2) {
                this.trimReferences()
            }
        }
    }

    private trimReferences(): void {
        // Shrink only by at least half, amortizing the free-list rebuild across released slots.
        // Live indices stay put: Lua userdata and other states can still hold them.
        this.references.length = this.highestReference
        this.firstFreeReference = 0
        for (let index = this.highestReference; index > 0; index--) {
            if (typeof this.references[index - 1] === 'number') {
                this.references[index - 1] = 0 - this.firstFreeReference
                this.firstFreeReference = index
            }
        }
    }

    public getRef(index: number): unknown {
        const entry = this.references[index - 1]
        return typeof entry === 'object' ? entry.value : undefined
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
        return userDataPointer ? this.getRef(this.readPointer(userDataPointer)) : undefined
    }

    /** The index {@link ref} already holds for `data`, without taking a count, or undefined. */
    public getRefIndex(data: unknown): number | undefined {
        return this.referenceIndexes.get(data as WeakKey)
    }

    // This is needed for some tests
    public getLastRefIndex(): number | undefined {
        return this.lastRefIndex
    }

    public printRefs(log = console.log): void {
        for (let index = 1; index <= this.references.length; index++) {
            const entry = this.references[index - 1]
            if (typeof entry === 'object') {
                log(index, entry.value)
            }
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
    protected withIntegerArgument(name: string, twoArguments = false): (...args: any[]) => any {
        const bigintBinding = this.exported(name)
        const numberBinding = this.exported(name.replace('lua_', 'wasmoon_'))

        return (a: any, b: any, c?: any): any => {
            const n = twoArguments ? b : c
            if (typeof n === 'bigint') {
                return bigintBinding(a, b, c)
            }
            if (!Number.isSafeInteger(n)) {
                throw new RangeError(`${n} is not a safe integer; pass a BigInt for the full lua_Integer range`)
            }
            return numberBinding(a, b, c)
        }
    }

    /** The wasm export `name`, which for a function that crosses only numbers is the binding itself. */
    protected exported(name: string): (...args: any[]) => any {
        const raw = (this.emscripten as unknown as Record<string, unknown>)[`_${name}`]
        if (typeof raw !== 'function') {
            throw new Error(`the wasm module does not export '${name}'`)
        }
        return raw as (...args: any[]) => any
    }

    /**
     * Wraps a C API export that marshals strings, as described by a {@link STRING_BINDINGS}
     * signature. Upstream's cwrap would fall back to ccall for these -- which rebuilds its converter
     * table, argument array and return handler on every call, most of the cost of the small C API
     * functions, and these are hot: metatable names, globals, table fields. Rest arguments and a
     * spread call would land on every one of them too, so the arguments are named and both the
     * argument positions and the arity are unrolled. Which slots hold a C string is fixed when the
     * binding is wrapped, so it is not worked out per call.
     */
    protected wrapWithStringArguments(raw: (...args: any[]) => any, signature: string): (...args: any[]) => any {
        const emscripten = this.emscripten
        const arity = signature.length - 1
        if (arity < 2 || arity > 5) {
            throw new Error(`wrapWithStringArguments only unrolls arities 2 to 5, not ${arity}`)
        }
        if (signature[1] !== 'n') {
            // Every binding takes the lua_State there, so that slot is not unrolled below.
            throw new Error('wrapWithStringArguments does not marshal the first argument')
        }

        const returnsString = signature[0] === 's'
        // `s` is a fixed name worth caching; `S` is a chunk of source or another one-off, which
        // would fill the cache and push the names that dominate these calls out of it.
        const mode = (letter: string | undefined): StringArgument =>
            letter === 's' ? StringArgument.Cached : letter === 'S' ? StringArgument.Uncached : StringArgument.None
        const s1 = mode(signature[2])
        const s2 = mode(signature[3])
        const s3 = mode(signature[4])
        const s4 = mode(signature[5])

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

// Common keys fit in eight bytes. Fixed-arity calls avoid a temporary array on cache misses.
function decodeAscii(heap: Uint8Array, pointer: number, length: number): string {
    switch (length) {
        case 1:
            return String.fromCharCode(heap[pointer])
        case 2:
            return String.fromCharCode(heap[pointer], heap[pointer + 1])
        case 3:
            return String.fromCharCode(heap[pointer], heap[pointer + 1], heap[pointer + 2])
        case 4:
            return String.fromCharCode(heap[pointer], heap[pointer + 1], heap[pointer + 2], heap[pointer + 3])
        case 5:
            return String.fromCharCode(heap[pointer], heap[pointer + 1], heap[pointer + 2], heap[pointer + 3], heap[pointer + 4])
        case 6:
            return String.fromCharCode(
                heap[pointer],
                heap[pointer + 1],
                heap[pointer + 2],
                heap[pointer + 3],
                heap[pointer + 4],
                heap[pointer + 5],
            )
        case 7:
            return String.fromCharCode(
                heap[pointer],
                heap[pointer + 1],
                heap[pointer + 2],
                heap[pointer + 3],
                heap[pointer + 4],
                heap[pointer + 5],
                heap[pointer + 6],
            )
        case 8:
            return String.fromCharCode(
                heap[pointer],
                heap[pointer + 1],
                heap[pointer + 2],
                heap[pointer + 3],
                heap[pointer + 4],
                heap[pointer + 5],
                heap[pointer + 6],
                heap[pointer + 7],
            )
        default: {
            const codes = new Array<number>(length)
            for (let index = 0; index < length; index++) {
                codes[index] = heap[pointer + index]
            }
            return String.fromCharCode.apply(null, codes)
        }
    }
}

/** Whether `text`, ASCII of the length being read, is exactly the bytes at `pointer`. */
function isAsciiAt(text: string, heap: Uint8Array, pointer: number): boolean {
    for (let index = 0; index < text.length; index++) {
        if (text.charCodeAt(index) !== heap[pointer + index]) {
            return false
        }
    }
    return true
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
