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

/**
 * What a run may use before it is interrupted. A run is each entry from JS into Lua: a `doString`
 * or `doFile`, a call of a Lua function, and the runs that `state.async`, Lua's `async` and a
 * promise reaction start.
 *
 * The same three fields everywhere a limit can be given: as `limits` when creating a state and as
 * `state.limits` afterwards, where they are what every run starts under, and in the options of a
 * single run, where each one given replaces the state's -- `Infinity` to lift it.
 *
 * A run made from inside another, by a JS function that Lua called calling back into Lua, stays
 * within the outer one's limits as well as its own.
 */
export interface LuaLimits {
    /** Milliseconds the run may take, awaits included. */
    timeout?: number | undefined
    /** Instructions the run may execute. */
    maxInstructions?: number | undefined
    /**
     * Interrupts the run when the signal aborts.
     *
     * Interrupts parked awaits and onYield handlers without waiting for their promises to settle.
     * A signal cannot fire while the event loop is blocked, so a timer cannot abort a tight Lua
     * loop without async steps; use `timeout` or `maxInstructions` for those. Repeated awaits
     * periodically give timers a turn, and a top level `coroutine.yield` without a handler always does.
     */
    signal?: AbortSignal | undefined
}

/** A global that `CreateStateOptions.inject` can define. */
export type LuaInjectName = 'Error' | 'Promise' | 'null' | 'async'

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
     * How an object crosses into Lua when nothing says otherwise: `'proxy'` (the default) keeps
     * its identity and exposes its members, `'copy'` marshals it into a plain Lua table.
     *
     * `copy(value)`, `proxy(value)` and `opaque(value)` say otherwise for one value, and
     * `defineClass` and `defineType` for every value of a kind. With `'copy'` those are the only
     * ways Lua gets to reach into a JS object, which is what a state running untrusted code wants.
     */
    objects?: 'proxy' | 'copy' | undefined
    /**
     * Which helpers to define as Lua globals. `true` defines all of them, or name them
     * individually:
     *
     * - `Promise`: `Promise.create`, `Promise.all` and `Promise.resolve`.
     * - `async`: `async(fn)` returns a function that runs `fn` as a run of its own and gives back
     *   a promise of its first result, so that it can `:await()` whoever calls it.
     * - `Error`: `Error.create`.
     * - `null`: a sentinel that a JS `null` is marshalled as instead of `nil`. It is truthy in Lua.
     */
    inject?: LuaInjectName[] | boolean | undefined
    /**
     * Called with the error of a function started through Lua's `async` when nothing was waiting
     * on the promise it returned: a callback a JS API called and forgot about, say. Without a
     * handler such a failure is an unhandled promise rejection, which is the host's to deal with
     * and by default ends a Node process.
     */
    onAsyncError?: ((error: unknown) => void) | undefined
    memory?: LuaMemoryOptions | undefined
    /** What every run on the state starts under, also reachable afterwards as `state.limits`. */
    limits?: LuaLimits | undefined
    gc?: LuaGcOptions | undefined
    /** Where diagnostics go. Defaults to the runtime's handler, and then to `console.warn`. */
    onWarn?: LuaWarnHandler | undefined
}

/** The limits of one run, each replacing the state's, and what to do when it yields. */
export interface LuaRunOptions extends LuaLimits {
    /**
     * Called with the values of a top level `coroutine.yield`. Its return
     * becomes the result of that yield when the run resumes; a returned promise is awaited first, a
     * `LuaMultiReturn` becomes several values, and `undefined` resumes with none. Without a handler
     * such a yield gives the event loop a turn and resumes with nothing.
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

/** A class, abstract or not, as `defineClass` takes it. */
export type LuaClass<T = any> = abstract new (...args: any[]) => T

export interface LuaClassOptions<T = any> {
    /**
     * Names the metatable: what `tostring` and Lua's error messages call an instance. Defaults to
     * the class's own name, and has to be unique in the state.
     */
    name?: string | undefined
    /**
     * The only members Lua can reach on an instance -- methods, fields and accessors alike, with
     * everything else reading as nil and refusing assignment. Without it every member is
     * reachable, inherited ones included.
     */
    members?: readonly (keyof T & string)[] | undefined
    /**
     * The only static members Lua can reach on the class. Without it, the ones the class and the
     * classes it extends declare.
     */
    statics?: readonly string[] | undefined
    /**
     * Metamethods for the instances, each called with the instance first: `__tostring`, `__eq`,
     * `__len`, `__add`, `__close` and the rest. `__index` or `__newindex` replace the member
     * lookup altogether.
     */
    metamethods?: Record<string, (self: T, ...args: any[]) => unknown> | undefined
}

export interface LuaTypeDefinition<T = any> {
    /**
     * Names the type's metatable: what `tostring` and Lua's error messages call a value of it. Has
     * to be unique in the state.
     */
    name: string
    /** Whether a JS value about to cross into Lua is of this type. */
    match: (value: unknown) => boolean
    /**
     * Metamethods for the type's metatable. A function among them is called with JS values, the
     * value of this type first.
     */
    metatable?: Record<string, unknown> | undefined
    /**
     * What to push in place of the value: anything that can cross into Lua, wrapped in `copy` and
     * the like if need be. Returning the value itself declines it, leaving it to whatever would
     * have handled it otherwise.
     *
     * Without this the value crosses by reference, as a userdata that reads back as itself.
     */
    toLua?: ((value: T) => unknown) | undefined
    /**
     * Turns a Lua table of this type back into a JS value, given the object or array the table
     * reads as. A table is of this type when `toLua` produced it, or when Lua code gave it a
     * metatable whose `__name` is this type's name.
     */
    fromLua?: ((value: any) => T) | undefined
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
