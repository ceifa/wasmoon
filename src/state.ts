import LuaGarbageCollector from './gc'
import Marshaller from './marshaller'
import type LuaModule from './module'
import Thread from './thread'
import ClassTypeExtension from './type-extensions/class'
import DefinedTypeExtension from './type-extensions/defined'
import createErrorType from './type-extensions/error'
import createFunctionType from './type-extensions/function'
import createNullType from './type-extensions/null'
import createPromiseType from './type-extensions/promise'
import createProxyType from './type-extensions/proxy'
import createTableType from './type-extensions/table'
import createUserdataType from './type-extensions/userdata'
import {
    type CreateStateOptions,
    LUA_REGISTRYINDEX,
    type LuaAddress,
    type LuaClass,
    type LuaClassOptions,
    type LuaDoOptions,
    type LuaInjectName,
    type LuaLimits,
    type LuaMemoryOptions,
    type LuaRunOptions,
    LuaType,
    type LuaTypeDefinition,
    resolveLibraryMask,
} from './types'

/**
 * Memory accounting for a state created with `memory.trace` or `memory.max`. Without either
 * `state.memory` is undefined, so the absence is a type error rather than a runtime one.
 */
export interface LuaMemory {
    /** Bytes currently allocated by this state. */
    readonly used: number
    /** Allocation ceiling in bytes, or undefined for unlimited. */
    max: number | undefined
}

interface CreatedState {
    address: LuaAddress
    memory?: LuaMemory
    allocatorFunctionPointer?: number
}

/**
 * Tracing needs its own allocator, which has to exist before `lua_newstate`, so this runs ahead
 * of the constructor body rather than branching around `super()` twice.
 */
function createAddress(cmodule: LuaModule, memory: LuaMemoryOptions | undefined): CreatedState {
    // A cap can only be enforced by the tracing allocator, so asking for one asks for tracing.
    if (!memory?.trace && memory?.max === undefined) {
        return { address: cmodule.luaL_newstate() }
    }

    const stats = { used: 0, max: memory.max }
    const allocatorFunctionPointer = cmodule.addFunction((_userData: number, pointer: number, oldSize: number, newSize: number): number => {
        if (newSize === 0) {
            if (pointer) {
                stats.used -= oldSize
                cmodule.emscripten._free(pointer)
            }
            return 0
        }

        const endMemoryDelta = pointer ? newSize - oldSize : newSize
        const endMemory = stats.used + endMemoryDelta

        if (newSize > oldSize && stats.max && endMemory > stats.max) {
            return 0
        }

        const reallocated = cmodule.emscripten._realloc(pointer, newSize)
        if (reallocated) {
            stats.used = endMemory
        }
        return reallocated
    }, 'iiiii')

    const address = cmodule.lua_newstate(
        allocatorFunctionPointer,
        null,
        ((Date.now() >>> 0) ^ Math.floor(Math.random() * 0x100000000)) >>> 0,
    )
    if (!address) {
        cmodule.removeFunction(allocatorFunctionPointer)
        // A cap the state cannot even be built under is the overwhelmingly likely cause, and it is
        // the one thing the caller can act on.
        throw new Error(
            memory.max === undefined
                ? 'lua_newstate returned a null pointer'
                : `a memory.max of ${memory.max} bytes is too small to create a Lua state`,
        )
    }

    return { address, memory: stats, allocatorFunctionPointer }
}

/**
 * An independent Lua state: its globals, its standard libraries and its main thread.
 *
 * Created through `runtime.createState()`. Several states can share one runtime, and closing one
 * does not affect the others.
 */
export default class LuaState extends Thread {
    /** Present only when the state was created with `memory.trace` or `memory.max`. */
    public readonly memory: LuaMemory | undefined
    public readonly gc: LuaGarbageCollector

    private readonly allocatorFunctionPointer: number | undefined

    public constructor(cmodule: LuaModule, options: CreateStateOptions = {}) {
        const { libs = true, objects = 'proxy', inject = false, memory, limits, gc, onWarn } = options
        const injects = (name: LuaInjectName): boolean => inject === true || (inject !== false && inject.includes(name))
        if (objects !== 'proxy' && objects !== 'copy') {
            throw new TypeError(`unknown objects option '${String(objects)}', expected proxy or copy`)
        }

        const created = createAddress(cmodule, memory)
        const marshaller = new Marshaller()
        super(cmodule, marshaller, created.address)

        this.memory = created.memory
        this.allocatorFunctionPointer = created.allocatorFunctionPointer
        this.onWarn = onWarn
        // A copy, so that the caller's object and `state.limits` can change independently.
        this.defaultLimits = { ...limits }

        if (this.isClosed()) {
            throw new Error('Lua state could not be created (probably due to lack of memory)')
        }

        this.gc = new LuaGarbageCollector(this, gc)

        // Each takes what it needs from the ones before it: a metatable's functions are pushed
        // through the function extension, and its tables through the table one.
        marshaller.objects = objects
        marshaller.tables = createTableType(this)
        marshaller.functions = createFunctionType(this, { onAsyncError: options.onAsyncError })
        marshaller.opaques = createUserdataType(this)
        marshaller.proxies = createProxyType(this)
        // Contains the :await functionality.
        marshaller.promises = createPromiseType(this, injects('Promise'))
        marshaller.errors = createErrorType(this, injects('Error'))
        if (injects('null')) {
            marshaller.nulls = createNullType(this)
        }

        const libraryMask = resolveLibraryMask(libs)
        if (libraryMask !== 0) {
            this.module.luaL_openselectedlibs(this.address, libraryMask, 0)
        }

        if (injects('async')) {
            marshaller.functions.injectAsync()
        }
    }

    /**
     * The limits every run on this state starts under: a `doString` or `doFile`, a call of a Lua
     * function from JS, and the runs `state.async`, Lua's `async` and a promise reaction start.
     * What a run is given itself (`doString(code, { timeout })`) goes over these field by field.
     *
     * Read when a run starts, so assigning it, or a field of it, changes the runs that start
     * afterwards and leaves the ones under way alone.
     */
    public get limits(): LuaLimits {
        return this.defaultLimits
    }

    public set limits(limits: LuaLimits | undefined) {
        this.defaultLimits = { ...limits }
    }

    /**
     * Executes Lua code from a string asynchronously.
     * @returns A Promise that resolves to the result returned by the Lua script execution. Nothing
     * checks it against `T`, which only saves the caller a cast.
     */
    public doString<T = any>(script: string, options?: LuaDoOptions): Promise<T> {
        return this.callByteCode((thread) => thread.loadString(script, options), options)
    }

    /**
     * Executes Lua code from a file asynchronously.
     * @returns A Promise that resolves to the result returned by the Lua script execution.
     */
    public doFile<T = any>(filename: string, options?: LuaDoOptions): Promise<T> {
        return this.callByteCode((thread) => thread.loadFile(filename, options), options)
    }

    /**
     * Executes Lua code from a string synchronously. Nothing can suspend a synchronous run, so
     * `:await()` and a top level `coroutine.yield` are errors here.
     */
    public doStringSync<T = any>(script: string, options?: LuaDoOptions): T {
        return this.callByteCodeSync((thread) => thread.loadString(script, options), options)
    }

    /**
     * Executes Lua code from a file synchronously. Nothing can suspend a synchronous run, so
     * `:await()` and a top level `coroutine.yield` are errors here.
     */
    public doFileSync<T = any>(filename: string, options?: LuaDoOptions): T {
        return this.callByteCodeSync((thread) => thread.loadFile(filename, options), options)
    }

    /**
     * The asynchronous counterpart of a Lua function obtained from this state, as `async function`
     * is to `function`. Called directly a Lua function runs synchronously, and an `:await()` in it
     * is an error; what this returns starts it as a run of its own instead, and gives back a
     * promise of its first result.
     *
     * ```js
     * emitter.on('request', state.async(handler))
     * const body = await state.async(fetchPage, { timeout: 1000 })(url)
     * ```
     *
     * Each call is a run like a `doString`, under the state's {@link limits} with `options` over
     * them.
     */
    public async<T = any>(fn: (...args: any[]) => any, options?: LuaRunOptions): (...args: any[]) => Promise<T> {
        return this.marshaller.functions.async(fn, options) as (...args: any[]) => Promise<T>
    }

    /** Whether `value` is a Lua function obtained from this state, the kind {@link async} takes. */
    public isLuaFunction(value: unknown): value is (...args: any[]) => any {
        return this.marshaller.functions.isLuaFunction(value)
    }

    /**
     * Defines how a kind of JS value crosses into Lua, ahead of how it otherwise would.
     *
     * Without `toLua` the value crosses by reference: a userdata with a metatable named after the
     * type, carrying the metamethods given, which reads back as the same JS value.
     *
     * ```js
     * state.defineType({
     *     name: 'Point',
     *     match: (value) => value instanceof Point,
     *     metatable: { __tostring: (point) => `Point(${point.x}, ${point.y})` },
     * })
     * ```
     *
     * With `toLua` it is converted instead, and `fromLua` converts back what Lua returns:
     *
     * ```js
     * state.defineType({
     *     name: 'Map',
     *     match: (value) => value instanceof Map,
     *     toLua: (map) => copy(Object.fromEntries(map)),
     *     fromLua: (table) => new Map(Object.entries(table)),
     * })
     * ```
     *
     * Types are consulted before classes and before the built in handling, the most recently
     * defined first. See {@link LuaTypeDefinition}.
     */
    public defineType<T = any>(definition: LuaTypeDefinition<T>): void {
        this.assertNotClosed()
        this.marshaller.addType(new DefinedTypeExtension<T>(this, definition) as DefinedTypeExtension)
    }

    /**
     * Gives a class a metatable of its own in Lua. Its instances then cross by reference as
     * userdata named after the class, whose methods are called the way Lua calls methods, with
     * `:`, and the class itself crosses as a value that constructs when called and exposes its
     * static members.
     *
     * ```js
     * state.defineClass(Vector, { members: ['x', 'y', 'length', 'add'] })
     * state.set('Vector', Vector)
     * await state.doString('local v = Vector(3, 4) return v:add(v):length()')
     * ```
     *
     * An instance of a subclass uses the nearest class that was defined. See
     * {@link LuaClassOptions}.
     */
    public defineClass<T extends object>(ctor: LuaClass<T>, options?: LuaClassOptions<T>): void {
        this.assertNotClosed()
        if (this.marshaller.hasClass(ctor)) {
            throw new Error(`the class '${ctor.name}' is already defined in this state`)
        }
        this.marshaller.addClass(new ClassTypeExtension<T>(this, ctor, options) as unknown as ClassTypeExtension)
    }

    /** Retrieves the value of a global variable. */
    public get<T = any>(name: string): T {
        // Without this a read from a closed state returns whatever the freed memory now holds,
        // which is the one failure mode with nothing to notice it by.
        this.assertNotClosed()
        const type = this.module.lua_getglobal(this.address, name)
        const value = this.getValue(-1, type)
        this.pop()
        return value
    }

    /** Sets the value of a global variable. */
    public set(name: string, value: unknown): void {
        this.assertNotClosed()
        this.pushValue(value)
        this.module.lua_setglobal(this.address, name)
    }

    public getTable(name: string, callback: (index: number) => void): void {
        this.assertNotClosed()
        const startStackTop = this.getTop()
        const type = this.module.lua_getglobal(this.address, name)
        try {
            if (type !== LuaType.Table) {
                throw new TypeError(`Unexpected type in ${name}. Expected ${LuaType[LuaType.Table]}. Got ${LuaType[type]}.`)
            }
            callback(startStackTop + 1)
        } finally {
            // Nothing to check or rewind on a state the callback closed, the same as the do* paths.
            if (!this.isClosed()) {
                // +1 for the table
                if (this.getTop() !== startStackTop + 1) {
                    this.warn(`getTable: expected stack size ${startStackTop + 1} got ${this.getTop()}`)
                }
                this.setTop(startStackTop)
            }
        }
    }

    /** Closes the state and frees everything it owns. Safe to call more than once. */
    public override close(): void {
        if (this.isClosed()) {
            return
        }

        super.close()

        // Do this before removing the gc to force.
        // Here rather than in the threads because you don't
        // actually close threads, just pop them. Only the top-level
        // lua state needs closing.
        this.module.lua_close(this.address)

        if (this.allocatorFunctionPointer) {
            this.module.removeFunction(this.allocatorFunctionPointer)
        }

        this.marshaller.close()
    }

    private callByteCodeSync(loader: (thread: Thread) => void, options?: LuaRunOptions): any {
        // Ahead of the stack bookkeeping below rather than left to the loader, so that a closed
        // state is refused before anything reads or rewinds the freed one.
        this.assertNotClosed()

        // Runs on the main thread so the script sees itself as the main coroutine, the way the
        // reference implementation behaves. That makes leftovers outlive the call, hence the rewind.
        const startStackTop = this.getTop()
        try {
            loader(this)
            return this.runSync(0, options)[0]
        } finally {
            // Closing runs the state's own teardown, which leaves nothing here to rewind.
            if (!this.isClosed()) {
                this.setTop(startStackTop)
            }
        }
    }

    // WARNING: It will not wait for open handles and can potentially cause bugs if JS code tries to reference Lua after executed
    private async callByteCode(loader: (thread: Thread) => void, options?: LuaRunOptions): Promise<any> {
        this.assertNotClosed()

        // Anchored so the run doesn't pile threads up on the global stack.
        const { thread, reference } = this.newAnchoredThread()
        try {
            loader(thread)
            return (await thread.run(0, options))[0]
        } finally {
            thread.close()
            // The await above gives anything else a chance to close the state, and lua_close has
            // already released the registry this would be unreferencing from.
            if (!this.isClosed()) {
                this.module.luaL_unref(this.address, LUA_REGISTRYINDEX, reference)
            }
        }
    }
}
