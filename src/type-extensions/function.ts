import { Decoration } from '../decoration'
import type LuaState from '../state'
import MultiReturn from '../multireturn'
import RawResult from '../raw-result'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import { LUA_REGISTRYINDEX, LuaReturn, type LuaAddress, LuaType, PointerSize } from '../types'
import { isEmscriptenUnwind } from '../utils'

export type FunctionType = (...args: any[]) => Promise<any> | any

class FunctionTypeExtension extends TypeExtension<FunctionType> {
    private readonly functionRegistry = new FinalizationRegistry((func: number) => {
        if (!this.state.isClosed()) {
            this.state.module.luaL_unref(this.state.address, LUA_REGISTRYINDEX, func)
        }
    })

    private gcPointer: number
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

        if (!this.functionRegistry) {
            state.warn('FunctionTypeExtension: FinalizationRegistry not found. Memory leaks likely.')
        }

        this.gcPointer = this.createGcFunction()

        // Creates metatable if it doesn't exist, always pushes it onto the stack.
        if (state.module.luaL_newmetatable(state.address, this.name)) {
            state.module.lua_pushstring(state.address, '__gc')
            state.module.lua_pushcclosure(state.address, this.gcPointer, 0)
            state.module.lua_settable(state.address, -3)

            state.module.lua_pushstring(state.address, '__metatable')
            state.module.lua_pushstring(state.address, 'protected metatable')
            state.module.lua_settable(state.address, -3)
        }
        // Pop the metatable from the stack.
        state.module.lua_pop(state.address, 1)

        this.functionWrapper = state.module.addFunction((calledL: LuaAddress) => {
            const calledThread = state.stateToThread(calledL)

            // The upvalue is always the userdata pushValue closed this wrapper over, so the
            // metatable check luaL_checkudata does (and the name it marshals) is saved on every
            // call. Only a ref that does not resolve to a function decoration -- the upvalue
            // replaced through the debug library -- falls back to it, for the error the C API
            // would have raised.
            const upvalueIndex = state.module.lua_upvalueindex(1)
            const refUserdata = state.module.lua_touserdata(calledL, upvalueIndex)
            const reference = refUserdata ? state.module.getRef(state.module.readPointer(refUserdata)) : undefined
            if (!(reference instanceof Decoration) || typeof reference.target !== 'function') {
                // Raises the error the C API would have; the throw below is unreachable.
                state.module.luaL_checkudata(calledL, upvalueIndex, this.name)
                throw new Error('a js_function upvalue does not hold a function reference')
            }
            const { target, options: decorationOptions } = reference

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
        this.state.module.removeFunction(this.gcPointer)
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

        const pointer = thread.module.ref(decoration)
        // 4 = size of pointer in wasm.
        const userDataPointer = thread.module.lua_newuserdatauv(thread.address, PointerSize, 0)
        thread.module.writePointer(userDataPointer, pointer)

        if (LuaType.Nil === thread.module.luaL_getmetatable(thread.address, this.name)) {
            // Pop the pushed userdata.
            thread.pop(1)
            thread.module.unref(pointer)
            throw new Error(`metatable not found: ${this.name}`)
        }

        // Set as the metatable for the function.
        // -1 is the metatable, -2 is the userdata
        thread.module.lua_setmetatable(thread.address, -2)

        // Pass 1 to associate the closure with the userdata, pops the userdata.
        thread.module.lua_pushcclosure(thread.address, this.functionWrapper, 1)

        return true
    }

    public getValue(thread: Thread, index: number): FunctionType {
        // Create a copy of the function
        thread.module.lua_pushvalue(thread.address, index)
        // Create a reference to the function which pops it from the stack
        const func = thread.module.luaL_ref(thread.address, LUA_REGISTRYINDEX)
        // The reference never changes, so the bigint the i64 parameter needs is built once.
        const funcReference = BigInt(func)

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
                const internalType = callThread.module.lua_rawgeti(callThread.address, LUA_REGISTRYINDEX, funcReference)
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

                if (callThread.getTop() > 0) {
                    return callThread.getValue(-1)
                }
                return undefined
            } catch (err) {
                failed = true
                throw err
            } finally {
                this.releaseCallThread(callThread, failed)
            }
        }

        this.functionRegistry?.register(jsFunc, func)

        return jsFunc
    }
}

export default function createTypeExtension(state: LuaState, functionTimeout?: number): TypeExtension<FunctionType> {
    return new FunctionTypeExtension(state, functionTimeout)
}
