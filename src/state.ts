import type LuaModule from './module'
import Thread from './thread'
import type LuaTypeExtension from './type-extension'
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
    type LuaDoOptions,
    type LuaMemoryOptions,
    type LuaRunOptions,
    LuaType,
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

/**
 * A more specific handler has to be consulted before a more general one. The values themselves
 * cannot be renumbered: they are the scale {@link LuaState.registerTypeExtension} exposes, so
 * anything a user registered against them would move too.
 */
const BUILT_IN_PRIORITY = {
    table: 0,
    function: 0,
    promise: 1,
    proxy: 3,
    /** Beats proxy, which would otherwise claim every Error before this one is consulted. */
    error: 3.5,
    /** Lets a custom userdata be exposed without its methods coming along. */
    userdata: 4,
    null: 5,
} as const

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

    private readonly allocatorFunctionPointer: number | undefined
    private readonly defaultMaxInstructions: number | undefined
    private readonly closeListeners: (() => void)[] = []

    public constructor(cmodule: LuaModule, options: CreateStateOptions = {}) {
        const { libs = true, objects = 'proxy', errors = objects === 'copy', inject = false, memory, limits, onWarn } = options

        const created = createAddress(cmodule, memory)
        super(cmodule, [], created.address)

        this.memory = created.memory
        this.allocatorFunctionPointer = created.allocatorFunctionPointer
        this.onWarn = onWarn

        if (this.isClosed()) {
            throw new Error('Lua state could not be created (probably due to lack of memory)')
        }

        // Generic handlers - These may be required to be registered for additional types.
        this.registerTypeExtension(BUILT_IN_PRIORITY.table, createTableType(this))
        this.registerTypeExtension(BUILT_IN_PRIORITY.function, createFunctionType(this, limits?.functionTimeout))

        // Contains the :await functionality.
        this.registerTypeExtension(BUILT_IN_PRIORITY.promise, createPromiseType(this, inject))

        if (inject) {
            this.registerTypeExtension(BUILT_IN_PRIORITY.null, createNullType(this))
        }

        if (errors) {
            this.registerTypeExtension(BUILT_IN_PRIORITY.error, createErrorType(this, inject))
        }

        if (objects === 'proxy') {
            // This extension only really overrides tables and arrays.
            // When a function is looked up in one of it's tables it's bound and then
            // handled by the function type extension.
            this.registerTypeExtension(BUILT_IN_PRIORITY.proxy, createProxyType(this))
        }

        this.registerTypeExtension(BUILT_IN_PRIORITY.userdata, createUserdataType(this))

        const libraryMask = resolveLibraryMask(libs)
        if (libraryMask !== 0) {
            this.module.luaL_openselectedlibs(this.address, libraryMask, 0)
        }

        this.defaultMaxInstructions = limits?.maxInstructions
    }

    /**
     * Executes Lua code from a string asynchronously.
     * @returns A Promise that resolves to the result returned by the Lua script execution. Nothing
     * checks it against `T`, which only saves the caller a cast.
     */
    public doString<T = any>(script: string, options?: LuaDoOptions): Promise<T> {
        return this.callByteCode((thread) => thread.loadString(script, options), this.runOptions(options))
    }

    /**
     * Executes Lua code from a file asynchronously.
     * @returns A Promise that resolves to the result returned by the Lua script execution.
     */
    public doFile<T = any>(filename: string, options?: LuaDoOptions): Promise<T> {
        return this.callByteCode((thread) => thread.loadFile(filename, options), this.runOptions(options))
    }

    /**
     * Executes Lua code from a string synchronously. The script cannot yield, so `:await()` and a
     * top level `coroutine.yield` are errors here.
     */
    public doStringSync<T = any>(script: string, options?: LuaDoOptions): T {
        return this.callByteCodeSync((thread) => thread.loadString(script, options), this.runOptions(options))
    }

    /**
     * Executes Lua code from a file synchronously. The script cannot yield, so `:await()` and a
     * top level `coroutine.yield` are errors here.
     */
    public doFileSync<T = any>(filename: string, options?: LuaDoOptions): T {
        return this.callByteCodeSync((thread) => thread.loadFile(filename, options), this.runOptions(options))
    }

    /**
     * Registers a type extension for Lua objects.
     * Higher priority is more important and will be evaluated first.
     * Allows library users to specify custom types
     */
    public registerTypeExtension(priority: number, extension: LuaTypeExtension<unknown>): void {
        this.typeExtensions.push({ extension, priority })
        this.typeExtensions.sort((a, b) => b.priority - a.priority)
    }

    /** Retrieves the value of a global variable. */
    public get<T = any>(name: string): T {
        const type = this.module.lua_getglobal(this.address, name)
        const value = this.getValue(-1, type)
        this.pop()
        return value
    }

    /** Sets the value of a global variable. */
    public set(name: string, value: unknown): void {
        this.pushValue(value)
        this.module.lua_setglobal(this.address, name)
    }

    public getTable(name: string, callback: (index: number) => void): void {
        const startStackTop = this.getTop()
        const type = this.module.lua_getglobal(this.address, name)
        try {
            if (type !== LuaType.Table) {
                throw new TypeError(`Unexpected type in ${name}. Expected ${LuaType[LuaType.Table]}. Got ${LuaType[type]}.`)
            }
            callback(startStackTop + 1)
        } finally {
            // +1 for the table
            if (this.getTop() !== startStackTop + 1) {
                this.warn(`getTable: expected stack size ${startStackTop + 1} got ${this.getTop()}`)
            }
            this.setTop(startStackTop)
        }
    }

    /** Notified once when this state closes, so an owner can drop its reference. */
    public onClose(listener: () => void): void {
        this.closeListeners.push(listener)
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

        for (const wrapper of this.typeExtensions) {
            wrapper.extension.close()
        }

        for (const listener of this.closeListeners) {
            listener()
        }
        this.closeListeners.length = 0
    }

    /** Folds the state wide budget in, so run() does the save and restore in one place. */
    private runOptions(options?: LuaDoOptions): LuaRunOptions | undefined {
        if (this.defaultMaxInstructions === undefined) {
            return options
        }
        return { maxInstructions: this.defaultMaxInstructions, ...options }
    }

    private callByteCodeSync(loader: (thread: Thread) => void, options?: LuaRunOptions): any {
        // Runs on the main thread so the script sees itself as the main coroutine, the way the
        // reference implementation behaves. That makes leftovers outlive the call, hence the rewind.
        const startStackTop = this.getTop()
        try {
            loader(this)
            return this.runSync(0, options)[0]
        } finally {
            this.setTop(startStackTop)
        }
    }

    // WARNING: It will not wait for open handles and can potentially cause bugs if JS code tries to reference Lua after executed
    private async callByteCode(loader: (thread: Thread) => void, options?: LuaRunOptions): Promise<any> {
        const thread = this.newThread()
        // Move the thread off the global stack and into the registry as a GC anchor so it doesn't pile threads up into the stack
        const ref = this.module.luaL_ref(this.address, LUA_REGISTRYINDEX)
        try {
            // Seeded from the state so a state wide setLimits reaches the async path too, which
            // runs on a child thread rather than on the state itself.
            thread.setLimits(this.getLimits())
            loader(thread)
            return (await thread.run(0, options))[0]
        } finally {
            thread.close()
            this.module.luaL_unref(this.address, LUA_REGISTRYINDEX, ref)
        }
    }
}
