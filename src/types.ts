import type MultiReturn from './multireturn'

/**
 * An address in the wasm heap: a `lua_State`, or the storage behind a Lua value. Emscripten
 * function pointers are table indices rather than addresses, so those stay plain numbers.
 */
export type LuaAddress = number

/** Receives diagnostics the library would otherwise have written to the console. */
export type LuaWarnHandler = (message: string, cause?: unknown) => void

export const defaultWarnHandler: LuaWarnHandler = (message, cause) => {
    if (cause === undefined) {
        console.warn(message)
    } else {
        console.warn(message, cause)
    }
}

export type LuaLibName = 'base' | 'package' | 'coroutine' | 'debug' | 'io' | 'math' | 'os' | 'string' | 'table' | 'utf8'

/**
 * Mirrors the `LUA_*K` bitmask in `lualib.h`. These are transcribed rather than derived, so
 * initialization.test.js opens each library alone and checks the global it installs, to catch a
 * reordering on a Lua version bump.
 */
export const LUA_LIB_BITS: Record<LuaLibName, number> = {
    base: 1,
    package: 2,
    coroutine: 4,
    debug: 8,
    io: 16,
    math: 32,
    os: 64,
    string: 128,
    table: 256,
    utf8: 512,
}

export const ALL_LUA_LIBS = ~0

export function resolveLibraryMask(libs: LuaLibName[] | boolean | undefined): number {
    if (libs === undefined || libs === true) {
        return ALL_LUA_LIBS
    }
    if (libs === false) {
        return 0
    }

    let mask = 0
    for (const lib of libs) {
        const bit = LUA_LIB_BITS[lib]
        if (bit === undefined) {
            throw new Error(`unknown Lua library '${String(lib)}', expected one of: ${Object.keys(LUA_LIB_BITS).join(', ')}`)
        }
        mask |= bit
    }
    return mask
}

/** `'t'` accepts text chunks only, `'bt'` also accepts precompiled bytecode. */
export type LuaLoadMode = 't' | 'bt'

export interface LuaMemoryOptions {
    /**
     * Installs a custom allocator so memory can be measured through `state.memory`, which is
     * undefined on a state that has neither this nor `max`.
     */
    trace?: boolean | undefined
    /** Maximum bytes the state may allocate. Implies `trace`, since the allocator enforces it. */
    max?: number | undefined
}

export interface LuaLimitOptions {
    /** Milliseconds a Lua function called from JS may run before being interrupted. */
    functionTimeout?: number | undefined
    /** Instructions a single run may execute before being interrupted. */
    maxInstructions?: number | undefined
}

/**
 * The tunables of `collectgarbage('param', ...)`. `pause`, `stepmul` and `stepsize` drive the
 * incremental collector, the other three the generational one.
 */
export type LuaGcParam = 'minormul' | 'majorminor' | 'minormajor' | 'pause' | 'stepmul' | 'stepsize'

export type LuaGcMode = 'incremental' | 'generational'

/** Applied before the standard libraries open, so even their tables are allocated under it. */
export interface LuaGcOptions {
    mode?: LuaGcMode | undefined
    params?: Partial<Record<LuaGcParam, number>> | undefined
}

export interface CreateStateOptions {
    /**
     * Which standard libraries to open. `true` opens all of them, `false` opens none (which
     * leaves the state without even `tostring`), or name them individually.
     */
    libs?: LuaLibName[] | boolean | undefined
    /**
     * How plain JS objects and class instances cross into Lua. `'proxy'` keeps their identity and
     * exposes their members, `'copy'` marshals them into plain Lua tables.
     */
    objects?: 'proxy' | 'copy' | undefined
    /**
     * Registers the JS `Error` to Lua error bridge. Defaults to true when `objects` is `'copy'`,
     * because the proxy already covers errors when it is enabled.
     */
    errors?: boolean | undefined
    /** Injects `Error`, `Promise` and `null` into the Lua globals. */
    inject?: boolean | undefined
    memory?: LuaMemoryOptions | undefined
    limits?: LuaLimitOptions | undefined
    gc?: LuaGcOptions | undefined
    /** Where diagnostics go. Defaults to the runtime's handler, and then to `console.warn`. */
    onWarn?: LuaWarnHandler | undefined
}

export interface LuaRunOptions {
    /** Milliseconds before the run is interrupted. */
    timeout?: number | undefined
    /** Instructions the run may execute before being interrupted. */
    maxInstructions?: number | undefined
    /**
     * Interrupts the run when the signal aborts.
     *
     * The abort is observed at the debug hook and around every yield, which has two consequences.
     * It cannot fire while the event loop is blocked, so a signal aborted from a timer will not
     * interrupt a tight synchronous Lua loop; use `timeout` or `maxInstructions` for those, since
     * the hook evaluates them on its own. And a run parked on a promise finishes awaiting that
     * promise before the abort is seen, rather than abandoning it mid-flight.
     */
    signal?: AbortSignal | undefined
    /**
     * Called with the values of a top level `coroutine.yield` that is not an `:await()`. Its return
     * becomes the result of that yield when the run resumes; a returned promise is awaited first, a
     * `LuaMultiReturn` becomes several values, and `undefined` resumes with none. Without a handler
     * such a yield simply hands control back to the event loop and resumes with nothing, as before.
     */
    onYield?: ((values: MultiReturn) => unknown | Promise<unknown>) | undefined
}

export interface LuaLoadOptions {
    /**
     * Defaults to `'t'`. Lua does not verify the consistency of binary chunks, so accepting
     * bytecode from an untrusted source is a memory safety hole rather than a sandbox escape.
     * Only widen this for chunks you produced yourself.
     */
    mode?: LuaLoadMode | undefined
    /** Chunk name used in error messages and tracebacks. */
    name?: string | undefined
}

export type LuaDoOptions = LuaRunOptions & LuaLoadOptions

/**
 * Deadline and budget enforced by the debug hook while a thread runs. Every field accepts an
 * explicit undefined, which clears that one limit.
 */
export interface LuaThreadLimits {
    /** Absolute timestamp, as returned by `Date.now()`. */
    deadline?: number | undefined
    maxInstructions?: number | undefined
    signal?: AbortSignal | undefined
}

export enum LuaReturn {
    Ok = 0,
    Yield = 1,
    ErrorRun = 2,
    ErrorSyntax = 3,
    ErrorMem = 4,
    ErrorErr = 5,
    ErrorFile = 6,
}

export interface LuaResumeResult {
    result: LuaReturn
    resultCount: number
}

/**
 * Memo threaded through a recursive read, keyed by the address of the Lua value, so a cyclic table
 * produces a cyclic JS object instead of recursing forever.
 */
export type LuaGetCache = Map<number, unknown>

/** The mirror of {@link LuaGetCache}, holding a registry reference to anchor each pushed value. */
export type LuaPushCache = Map<unknown, number>

export const PointerSize = 4

export const LUA_MULTRET = -1
export const LUAI_MAXSTACK = 1000000
export const LUA_REGISTRYINDEX = -(Math.trunc(0x7fffffff / 2) + 1000)

export enum LuaType {
    None = -1,
    Nil = 0,
    Boolean = 1,
    LightUserdata = 2,
    Number = 3,
    String = 4,
    Table = 5,
    Function = 6,
    Userdata = 7,
    Thread = 8,
}

/** The `what` argument of `lua_gc`. */
export enum LuaGcWhat {
    Stop = 0,
    Restart = 1,
    Collect = 2,
    Count = 3,
    CountB = 4,
    Step = 5,
    IsRunning = 6,
    Gen = 7,
    Inc = 8,
    Param = 9,
}

/** The `LUA_GCP*` indices of `lua_gc(L, LUA_GCPARAM, ...)`. */
export const LUA_GC_PARAMS: Record<LuaGcParam, number> = {
    minormul: 0,
    majorminor: 1,
    minormajor: 2,
    pause: 3,
    stepmul: 4,
    stepsize: 5,
}

export enum LuaEventCodes {
    Call = 0,
    Ret = 1,
    Line = 2,
    Count = 3,
    TailCall = 4,
}

export enum LuaEventMasks {
    Call = 1 << LuaEventCodes.Call,
    Ret = 1 << LuaEventCodes.Ret,
    Line = 1 << LuaEventCodes.Line,
    Count = 1 << LuaEventCodes.Count,
}

/**
 * An error raised by Lua itself. The pieces are kept apart rather than flattened into `message`
 * so callers can match on `code`, re-raise `luaValue`, or render the traceback separately.
 */
export class LuaError extends Error {
    public override readonly name: string = 'LuaError'
    /** Which `lua_pcall`/`lua_resume` status produced this. */
    public readonly code: LuaReturn
    /** The error text on its own, without the traceback appended. */
    public readonly luaMessage: string
    public readonly traceback: string | undefined
    /** The value Lua actually raised, which is not always a string. */
    public readonly luaValue: unknown

    public constructor(code: LuaReturn, luaMessage: string, options: { traceback?: string | undefined; luaValue?: unknown } = {}) {
        super(luaMessage)
        this.code = code
        this.luaMessage = luaMessage
        this.traceback = options.traceback
        this.luaValue = options.luaValue

        if (options.luaValue instanceof Error && options.luaValue.stack) {
            // A JS error that travelled through Lua keeps the stack from where it was thrown.
            this.stack = options.luaValue.stack
        } else if (options.traceback) {
            // Default logging only prints `stack`, so the traceback still has to be reachable
            // there even though it is no longer part of the message.
            this.stack = `${this.name}: ${luaMessage}\n${options.traceback}`
        }
    }
}

/**
 * Raised by the debug hook to unwind a run that hit a limit. These are control flow rather than
 * Lua errors, so they reach the caller unwrapped instead of inside a {@link LuaError}, and a
 * single `catch` covers every way a run can be cut short.
 */
export class LuaInterruptError extends Error {
    public override readonly name: string = 'LuaInterruptError'
}

export class LuaTimeoutError extends LuaInterruptError {
    public override readonly name: string = 'LuaTimeoutError'
}

export class LuaInstructionLimitError extends LuaInterruptError {
    public override readonly name: string = 'LuaInstructionLimitError'
}

export class LuaAbortError extends LuaInterruptError {
    public override readonly name: string = 'LuaAbortError'
}
