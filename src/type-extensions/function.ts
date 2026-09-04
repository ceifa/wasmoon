import { Decoration, type DecorationOptions } from '../decoration'
import type LuaState from '../state'
import MultiReturn from '../multireturn'
import RawResult from '../raw-result'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import { LUA_REGISTRYINDEX, LuaReturn, type LuaAddress, LuaType } from '../types'
import { isEmscriptenUnwind } from '../utils'

export type FunctionType = (...args: any[]) => Promise<any> | any

const NO_OPTIONS: DecorationOptions = {}

/** Whether the wrapper would behave any differently for these options than for none. */
function affectsCall(options: DecorationOptions): boolean {
    return options.self !== undefined || options.receiveThread === true || options.receiveArgsQuantity === true
}

class FunctionTypeExtension extends TypeExtension<FunctionType> {
    private readonly functionRegistry = new FinalizationRegistry((func: number) => {
        if (!this.state.isClosed()) {
            this.state.module.luaL_unref(this.state.address, LUA_REGISTRYINDEX, func)
        }
    })

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
    /** Milliseconds a Lua function called from JS may run before being interrupted. */
    private readonly functionTimeout: number | undefined

    public constructor(state: LuaState, functionTimeout?: number) {
        super(state, 'js_function')

        this.functionTimeout = functionTimeout
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

                if (result === undefined) {
                    return 0
                } else if (result instanceof RawResult) {
                    return result.count
                } else if (result instanceof MultiReturn) {
                    for (const item of result) {
                        calledThread.pushValue(item)
                    }
                    return result.length
                } else {
                    calledThread.pushValue(result)
                    return 1
                }
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
            return this.callbackContext.newThread()
        }

        this.pooledCallThreadInUse = true
        return this.pooledCallThread
    }

    private releaseCallThread(callThread: Thread, failed: boolean): void {
        if (callThread !== this.pooledCallThread) {
            callThread.close()
            // Pop thread used for function call.
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

        this.pushReference(thread, referent, this.functionWrapper)
        return true
    }

    public getValue(thread: Thread, index: number): FunctionType {
        // Create a copy of the function
        thread.module.lua_pushvalue(thread.address, index)
        // Create a reference to the function which pops it from the stack
        const func = thread.module.luaL_ref(thread.address, LUA_REGISTRYINDEX)

        const jsFunc = (...args: any[]): any => {
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

            // A call can leave its thread in an inconsistent state, so each one gets a thread that
            // is either fresh or has been reset since the last call.
            const callThread = this.acquireCallThread()
            let failed = false
            try {
                const internalType = callThread.module.lua_rawgeti(callThread.address, LUA_REGISTRYINDEX, func)
                if (internalType !== LuaType.Function) {
                    const callMetafieldType = callThread.module.luaL_getmetafield(callThread.address, -1, '__call')
                    callThread.pop()
                    if (callMetafieldType !== LuaType.Function) {
                        throw new TypeError(`cannot call a value of type ${LuaType[internalType]}: it has no __call metamethod`)
                    }
                }

                for (const arg of args) {
                    callThread.pushValue(arg)
                }

                if (this.functionTimeout) {
                    callThread.setDeadline(Date.now() + this.functionTimeout)
                }

                const status = callThread.module.lua_pcallk(callThread.address, args.length, 1, 0, 0, null)
                if (status === LuaReturn.Yield) {
                    throw new Error('cannot yield in callbacks from javascript')
                }
                callThread.assertOk(status)

                // Asking for one result leaves exactly one, nil included, so the top is where it is.
                return callThread.getValue(1)
            } catch (err) {
                failed = true
                throw err
            } finally {
                this.releaseCallThread(callThread, failed)
            }
        }

        this.functionRegistry.register(jsFunc, func)

        return jsFunc
    }
}

export default function createTypeExtension(state: LuaState, functionTimeout?: number): TypeExtension<FunctionType> {
    return new FunctionTypeExtension(state, functionTimeout)
}
