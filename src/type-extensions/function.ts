import { decorate, Decoration, type DecorationOptions } from '../decoration'
import RawResult from '../raw-result'
import type LuaState from '../state'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import { LUA_REGISTRYINDEX, LuaReturn, type LuaAddress, type LuaRunOptions, LuaType } from '../types'
import { isEmscriptenUnwind } from '../utils'
import { reportIfUnobserved, SUSPEND } from '../async'

export type FunctionType = (...args: any[]) => Promise<any> | any

/** A Lua function as JS sees it, carrying the registry reference of the function it calls. */
type LuaFunction = FunctionType & Record<symbol, number | undefined>

/** The parts of the state's options that bear on calling a Lua function. */
export interface FunctionCallOptions {
    /** Milliseconds a Lua function called from JS may run before being interrupted. */
    functionTimeout?: number | undefined
    /** Instructions an asynchronous run of a function may execute, as for any other run. */
    maxInstructions?: number | undefined
    /** See `CreateStateOptions.onAsyncError`. */
    onAsyncError?: ((error: unknown) => void) | undefined
}

const NO_OPTIONS: DecorationOptions = {}

/**
 * What `async(fn)` returns, as a chunk that takes the JS function starting the run and gives back
 * the function doing the wrapping. See {@link FunctionTypeExtension.injectAsync}.
 */
const ASYNC_SOURCE = `local start = ...
return function(fn)
    return function(...) return start(fn, ...) end
end`

/** Whether the wrapper would behave any differently for these options than for none. */
function affectsCall(options: DecorationOptions): boolean {
    return options.self !== undefined || options.receiveThread === true || options.receiveArgsQuantity === true
}

export class FunctionTypeExtension extends TypeExtension<FunctionType> {
    private readonly functionRegistry = new FinalizationRegistry((func: number) => {
        if (!this.state.isClosed()) {
            this.state.module.luaL_unref(this.state.address, LUA_REGISTRYINDEX, func)
        }
    })
    /**
     * Keys the registry reference on each Lua function handed to JS, which is how {@link async}
     * finds the function to run. A symbol of this state's own, so another state's function does not
     * answer to it, and a property rather than a WeakMap entry, which cost more than the rest of
     * creating the wrapper put together.
     */
    private readonly luaFunction = Symbol('wasmoon.luaFunction')

    private functionWrapper: number
    private callbackContext: Thread
    /**
     * One call thread kept ready instead of a `lua_newthread` per call, which was most of the cost
     * of calling a Lua function from JS. Anchored in the registry rather than on the callback
     * context's stack, and handed out only when no other call is using it: a reentrant call (Lua →
     * JS → Lua) falls back to a thread of its own.
     */
    private readonly pooledCallThread: Thread
    private pooledCallThreadInUse = false
    private readonly functionTimeout: number | undefined
    private readonly maxInstructions: number | undefined
    private readonly onAsyncError: ((error: unknown) => void) | undefined

    public constructor(state: LuaState, options: FunctionCallOptions = {}) {
        super(state, 'js_function')

        this.functionTimeout = options.functionTimeout
        this.maxInstructions = options.maxInstructions
        this.onAsyncError = options.onAsyncError
        // Create a thread off of the global thread to be used to create function call threads without
        // interfering with the global context. This creates a callback context that will always exist
        // even if the thread that called getValue() has been destroyed. Neither anchor is ever
        // released, for the reason given on LuaTypeExtension.close.
        this.callbackContext = state.newAnchoredThread().thread
        this.pooledCallThread = this.callbackContext.newAnchoredThread().thread

        // Nothing but the box's own __gc: the metatable goes on the upvalue, not on the closure
        // Lua sees, so no metamethod on it could ever be reached.
        this.defineMetatable()

        this.functionWrapper = state.module.addFunction((calledL: LuaAddress) => {
            const calledThread = state.stateToThread(calledL)

            // The upvalue is always the userdata pushValue closed this wrapper over, so the
            // metatable check luaL_checkudata does (and the name it marshals) is saved on every
            // call. Only a ref that resolves to neither a function nor a function decoration -- the
            // upvalue replaced through the debug library -- falls back to it, for the error the C
            // API would have raised.
            const upvalueIndex = state.module.lua_upvalueindex(1)
            const reference = state.module.getReferenceBox(calledL, upvalueIndex)
            let target: FunctionType
            let decorationOptions: DecorationOptions
            if (typeof reference === 'function') {
                target = reference as FunctionType
                decorationOptions = NO_OPTIONS
            } else if (reference instanceof Decoration && typeof reference.target === 'function') {
                target = reference.target
                decorationOptions = reference.options
            } else {
                // Raises the error the C API would have; the throw below is unreachable.
                state.module.luaL_checkudata(calledL, upvalueIndex, this.name)
                throw new Error('a js_function upvalue does not hold a function reference')
            }

            const argsQuantity = calledThread.getTop()
            const args = []

            if (decorationOptions.receiveThread) {
                args.push(calledThread)
            }

            if (decorationOptions.receiveArgsQuantity) {
                args.push(argsQuantity)
            } else {
                for (let i = 1; i <= argsQuantity; i++) {
                    const value = calledThread.getValue(i)
                    if (i !== 1 || !decorationOptions?.self || value !== decorationOptions.self) {
                        args.push(value)
                    }
                }
            }

            try {
                const result = target.apply(decorationOptions?.self, args)

                if (result === SUSPEND) {
                    // The JS function stashed a promise and asked to suspend: -1 tells the C
                    // trampoline to reach the await hook, which is the only value it treats specially.
                    return -1
                }
                return calledThread.pushReturnValues(result)
            } catch (err) {
                if (isEmscriptenUnwind(err)) {
                    throw err
                }
                calledThread.pushValue(err)
                return calledThread.module.lua_error(calledThread.address)
            }
        }, 'ii')
    }

    public close(): void {
        this.state.module.removeFunction(this.functionWrapper)
        // Doesn't destroy the Lua threads, just function pointers. The threads themselves went
        // with the state.
        this.pooledCallThread.close()
        this.callbackContext.close()
    }

    private acquireCallThread(): Thread {
        if (this.pooledCallThreadInUse) {
            // Left on the callback context's stack, which synchronous calls unwind in order.
            return this.callbackContext.newThread()
        }

        this.pooledCallThreadInUse = true
        return this.pooledCallThread
    }

    private releaseCallThread(callThread: Thread, failed: boolean): void {
        if (this.state.isClosed()) {
            this.pooledCallThreadInUse = false
            return
        }
        if (callThread !== this.pooledCallThread) {
            callThread.close()
            this.callbackContext.pop()
            return
        }

        if (failed) {
            // A failed call can leave more behind than stack values: a suspended coroutine, or
            // pending to-be-closed variables. Resetting closes those, so the thread is always
            // reusable afterwards. Not on every release, because a reset also shrinks the stack
            // just to regrow it on the next call; and not Thread.resetThread, whose status
            // assertion would throw out of the finally this runs in while the call error is
            // already propagating -- the setTop clears the error object a failed reset leaves
            // behind instead.
            this.state.module.lua_resetthread(callThread.address)
        }
        callThread.setTop(0)
        this.pooledCallThreadInUse = false
    }

    public isType(_thread: Thread, _index: number, type: LuaType): boolean {
        return type === LuaType.Function
    }

    public pushValue(thread: Thread, decoration: Decoration<unknown>): boolean {
        if (typeof decoration.target !== 'function') {
            return false
        }

        // It's surprisingly inefficient to map JS functions to C functions so this creates a reference to the
        // function which stays solely in JS. The cfunction called from Lua is created at the top of the class
        // and it accesses the JS data through an upvalue.
        //
        // The wrapper only needs the decoration when it carries an option it acts on. Otherwise the
        // bare function is referenced instead, so that every push of the same function -- decorated
        // or not, since Thread.pushValue synthesises a fresh decoration for a plain one -- shares
        // one reference and, through the cache below, one Lua closure. A decoration with options
        // is referenced as it is: the same instance pushed twice still yields one closure, while
        // the same function under different options stays distinct, as its behaviour is.
        const referent: unknown = affectsCall(decoration.options) ? decoration : decoration.target

        // Pushed through the C trampoline rather than a bare closure, so an `:await()` inside the
        // function can suspend the wasm stack. The trampoline holds the reference box as its first
        // upvalue and the wrapper as its second.
        this.pushReference(thread, referent, (L) => this.state.module.wasmoon_push_jsfunction(L, this.functionWrapper))
        return true
    }

    public getValue(thread: Thread, index: number): FunctionType {
        // Create a copy of the function
        thread.module.lua_pushvalue(thread.address, index)
        // Create a reference to the function which pops it from the stack
        const func = thread.module.luaL_ref(thread.address, LUA_REGISTRYINDEX)

        const jsFunc = (...args: any[]): any => {
            this.assertCallable()

            // A call can leave its thread in an inconsistent state, so each one gets a thread that
            // is either fresh or has been reset since the last call.
            const callThread = this.acquireCallThread()
            let result: unknown
            try {
                // Spelled out rather than shared with async through a helper: this is the call
                // the interop benchmarks measure, and the extra frame showed up in them.
                const internalType = callThread.module.lua_rawgeti(callThread.address, LUA_REGISTRYINDEX, func)
                if (internalType !== LuaType.Function) {
                    this.assertHasCallMetamethod(callThread, internalType)
                }

                for (const arg of args) {
                    callThread.pushValue(arg)
                }

                if (this.functionTimeout) {
                    callThread.setDeadline(Date.now() + this.functionTimeout)
                }

                // Resumed rather than pcalled, which costs the same and reports a yield as a status
                // this can name, instead of as Lua's error about yielding outside a coroutine.
                const resumed = callThread.resume(args.length)
                if (resumed.result === LuaReturn.Yield) {
                    throw new Error('cannot yield in a Lua function called synchronously from JS, wrap it with state.async to let it')
                }
                callThread.assertOk(resumed.result)
                result = resumed.resultCount >= 1 ? callThread.getValue(1) : null
            } catch (err) {
                this.releaseCallThread(callThread, true)
                throw err
            }
            this.releaseCallThread(callThread, false)
            return result
        }

        this.functionRegistry.register(jsFunc, func)
        ;(jsFunc as LuaFunction)[this.luaFunction] = func

        return jsFunc
    }

    /** Whether `value` is one of this state's Lua functions, as {@link getValue} hands them to JS. */
    public isLuaFunction(value: unknown): value is FunctionType {
        return typeof value === 'function' && (value as LuaFunction)[this.luaFunction] !== undefined
    }

    /**
     * The asynchronous counterpart of a Lua function: calling what this returns starts the function
     * as a run of its own instead of synchronously, which is what lets it `:await()`, and gives
     * back a promise of its first result.
     */
    public async(jsFunc: FunctionType, options?: LuaRunOptions): (...args: unknown[]) => Promise<unknown> {
        if (!this.isLuaFunction(jsFunc)) {
            throw new TypeError('async expects a Lua function obtained from this state')
        }
        return (...args) =>
            this.runCall((thread) => {
                // Read off the function on every call rather than once above: holding on to it is
                // what keeps its registry reference from being released.
                const func = (jsFunc as LuaFunction)[this.luaFunction]!
                const internalType = thread.module.lua_rawgeti(thread.address, LUA_REGISTRYINDEX, func)
                if (internalType !== LuaType.Function) {
                    this.assertHasCallMetamethod(thread, internalType)
                }
                for (const arg of args) {
                    thread.pushValue(arg)
                }
                return args.length
            }, options)
    }

    /**
     * Defines the Lua global `async`: what `async function` is to JS. `async(fn)` returns a function
     * that runs `fn` as a run of its own, so that it can `:await()` wherever it is called from, and
     * hands back a promise of its first result.
     *
     * What it returns is a Lua closure over `fn`, built by {@link ASYNC_SOURCE}, rather than a JS
     * function holding it: that way nothing has to be collected across the two heaps, and the
     * arguments of a call move from one Lua stack to another without ever becoming JS values.
     */
    public injectAsync(): void {
        const { state } = this
        const module = state.module
        const raw = { receiveThread: true, receiveArgsQuantity: true }
        const { onAsyncError } = this
        // Called with the function and then its arguments, which are still on the caller's stack.
        const start = decorate((caller: Thread, valueCount: number) => {
            const run = this.runCall((thread) => {
                module.lua_xmove(caller.address, thread.address, valueCount)
                return valueCount - 1
            })
            return onAsyncError ? reportIfUnobserved(run, onAsyncError) : run
        }, raw)
        // Compiled by the first call rather than for every state that injects it, most of which
        // never make one: loading it up front cost a quarter of creating the state.
        let wrap: number | undefined

        state.set(
            'async',
            decorate((thread: Thread) => {
                const L = thread.address
                const type = module.lua_type(L, 1)
                if (type !== LuaType.Function) {
                    throw new TypeError(`async expects a function, got ${module.lua_typename(L, type)}`)
                }
                if (wrap === undefined) {
                    thread.loadString(ASYNC_SOURCE, { name: '=async' })
                    thread.pushValue(start)
                    module.lua_callk(L, 1, 1, 0, null)
                    wrap = module.luaL_ref(L, LUA_REGISTRYINDEX)
                }
                module.lua_rawgeti(L, LUA_REGISTRYINDEX, wrap)
                module.lua_pushvalue(L, 1)
                module.lua_callk(L, 1, 1, 0, null)
                return new RawResult(1)
            }, raw),
        )
    }

    /**
     * Runs what `prepare` leaves on a new thread -- a function, and as many arguments as it returns
     * the count of -- as a run of its own, and resolves to its first result. A function that
     * returned nil resolves to undefined like one that returned nothing, rather than to the null
     * that `inject` marshals back into Lua as a sentinel, which is truthy there.
     */
    private async runCall(prepare: (thread: Thread) => number, options?: LuaRunOptions): Promise<unknown> {
        this.assertCallable()

        // A thread of its own rather than the pooled one, which a parked run would keep from every
        // synchronous call made in the meantime.
        const { thread, reference } = this.callbackContext.newAnchoredThread()
        try {
            // The limits any other run starts under, and the function timeout on top of them.
            thread.setLimits(this.state.getLimits())
            const { functionTimeout: timeout, maxInstructions } = this
            const defaults = timeout !== undefined || maxInstructions !== undefined
            const values = await thread.run(prepare(thread), defaults ? { timeout, maxInstructions, ...options } : options)
            return values[0] ?? undefined
        } finally {
            // The same teardown as LuaState.callByteCode. Sharing it through a helper costs each
            // parked doString a closure its suspended frame keeps alive.
            thread.close()
            if (!this.state.isClosed()) {
                this.state.module.luaL_unref(this.callbackContext.address, LUA_REGISTRYINDEX, reference)
            }
        }
    }

    private assertCallable(): void {
        // Calling a function would ideally be in the Lua context that's calling it. For example if the JS function
        // setInterval were exposed to Lua then the calling thread would be created in that Lua context for executing
        // the function call back to Lua through JS. However, if getValue were called in a thread, the thread then
        // destroyed, and then this JS func were called it would be calling from a dead context. That means the safest
        // thing to do is to have a thread you know will always exist.
        if (this.callbackContext.isClosed()) {
            // Returning undefined here surfaced the mistake several layers away from the
            // call that actually used a dead state.
            throw new Error('cannot call a Lua function after its state has been closed')
        }
    }

    /** Throws unless the non-function on top of the stack, a value of `type`, can be called anyway. */
    private assertHasCallMetamethod(thread: Thread, type: LuaType): void {
        const callMetafieldType = thread.module.luaL_getmetafield(thread.address, -1, '__call')
        thread.pop()
        if (callMetafieldType !== LuaType.Function) {
            throw new TypeError(`cannot call a value of type ${LuaType[type]}: it has no __call metamethod`)
        }
    }
}

export default function createTypeExtension(state: LuaState, options?: FunctionCallOptions): FunctionTypeExtension {
    return new FunctionTypeExtension(state, options)
}
