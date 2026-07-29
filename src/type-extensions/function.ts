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
    private callbackContextIndex: number
    /** Milliseconds a Lua function called from JS may run before being interrupted. */
    private readonly functionTimeout: number | undefined

    public constructor(state: LuaState, functionTimeout?: number) {
        super(state, 'js_function')

        this.functionTimeout = functionTimeout
        // Create a thread off of the global thread to be used to create function call threads without
        // interfering with the global context. This creates a callback context that will always exist
        // even if the thread that called getValue() has been destroyed.
        this.callbackContext = state.newThread()
        // Pops it from the global stack but keeps it alive
        this.callbackContextIndex = this.state.module.luaL_ref(state.address, LUA_REGISTRYINDEX)

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

        this.functionWrapper = state.module.emscripten.addFunction((calledL: LuaAddress) => {
            const calledThread = state.stateToThread(calledL)

            const refUserdata = state.module.luaL_checkudata(calledL, state.module.lua_upvalueindex(1), this.name)
            const refPointer = state.module.emscripten.getValue(refUserdata, '*')
            const { target, options: decorationOptions } = state.module.getRef(refPointer) as Decoration<FunctionType>

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
        this.state.module.emscripten.removeFunction(this.gcPointer)
        this.state.module.emscripten.removeFunction(this.functionWrapper)
        // Doesn't destroy the Lua thread, just function pointers.
        this.callbackContext.close()
        // Destroy the Lua thread
        this.callbackContext.module.luaL_unref(this.callbackContext.address, LUA_REGISTRYINDEX, this.callbackContextIndex)
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
        thread.module.emscripten.setValue(userDataPointer, pointer, '*')

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

            // Function calls back to value should always be within a new thread because
            // they can be left in inconsistent states.
            const callThread = this.callbackContext.newThread()
            try {
                const internalType = callThread.module.lua_rawgeti(callThread.address, LUA_REGISTRYINDEX, BigInt(func))
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
            } finally {
                callThread.close()
                // Pop thread used for function call.
                this.callbackContext.pop()
            }
        }

        this.functionRegistry?.register(jsFunc, func)

        return jsFunc
    }
}

export default function createTypeExtension(state: LuaState, functionTimeout?: number): TypeExtension<FunctionType> {
    return new FunctionTypeExtension(state, functionTimeout)
}
