import { BaseDecorationOptions, Decoration } from '../decoration'
import Global from '../global'
import MultiReturn from '../multireturn'
import RawResult from '../raw-result'
import Thread from '../thread'
import TypeExtension from '../type-extension'
import { LUA_REGISTRYINDEX, LuaReturn, LuaState, LuaType, PointerSize } from '../types'

export interface FunctionDecoration extends BaseDecorationOptions {
    receiveArgsQuantity?: boolean
    receiveThread?: boolean
    self?: any
}

export type FunctionType = (...args: any[]) => Promise<any> | any

export function decorateFunction(t: FunctionType, o: FunctionDecoration): Decoration<FunctionType, FunctionDecoration> {
    return new Decoration<FunctionType, FunctionDecoration>(t, o)
}

export interface FunctionTypeExtensionOptions {
    functionTimeout?: number
}

class FunctionTypeExtension extends TypeExtension<FunctionType, FunctionDecoration> {
    private readonly functionRegistry = new FinalizationRegistry((func: number) => {
        if (!this.thread.isClosed()) {
            this.thread.lua.luaL_unref(this.thread.address, LUA_REGISTRYINDEX, func)
        }
    })

    private gcPointer: number
    private functionWrapper: number
    private callbackContext: Thread
    private callbackContextIndex: number
    private options?: FunctionTypeExtensionOptions

    public constructor(t: Global, o?: FunctionTypeExtensionOptions) {
        super(t, 'js_function')

        this.options = o
        // Create a thread off of the global thread to be used to create function call threads without
        // interfering with the global context. This creates a callback context that will always exist
        // even if the thread that called getValue() has been destroyed.
        this.callbackContext = t.newThread()
        // Pops it from the global stack but keeps it alive
        this.callbackContextIndex = this.thread.lua.luaL_ref(t.address, LUA_REGISTRYINDEX)

        if (!this.functionRegistry) {
            console.warn('FunctionTypeExtension: FinalizationRegistry not found. Memory leaks likely.')
        }

        this.gcPointer = t.lua._emscripten.addFunction((calledL: LuaState) => {
            // Throws a lua error which does a jump if it does not match.
            t.lua.luaL_checkudata(calledL, 1, this.name)

            const userDataPointer = t.lua.luaL_checkudata(calledL, 1, this.name)
            const referencePointer = t.lua._emscripten.getValue(userDataPointer, '*')
            t.lua.unref(referencePointer)

            return LuaReturn.Ok
        }, 'ii')

        // Creates metatable if it doesn't exist, always pushes it onto the stack.
        if (t.lua.luaL_newmetatable(t.address, this.name)) {
            t.lua.lua_pushstring(t.address, '__gc')
            t.lua.lua_pushcclosure(t.address, this.gcPointer, 0)
            t.lua.lua_settable(t.address, -3)

            t.lua.lua_pushstring(t.address, '__metatable')
            t.lua.lua_pushstring(t.address, 'protected metatable')
            t.lua.lua_settable(t.address, -3)
        }
        // Pop the metatable from the stack.
        t.lua.lua_pop(t.address, 1)

        this.functionWrapper = t.lua._emscripten.addFunction((calledL: LuaState) => {
            const calledThread = t.stateToThread(calledL)

            const refUserdata = t.lua.luaL_checkudata(calledL, t.lua.lua_upvalueindex(1), this.name)
            const refPointer = t.lua._emscripten.getValue(refUserdata, '*')
            const { target, options: decorationOptions } = t.lua.getRef(refPointer) as Decoration<FunctionType, FunctionDecoration>

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
                // Performs a longjmp
                if (err === Infinity) {
                    throw err
                }
                calledThread.pushValue(err)
                return calledThread.lua.lua_error(calledThread.address)
            }
        }, 'ii')
    }

    public close(): void {
        this.thread.lua._emscripten.removeFunction(this.gcPointer)
        this.thread.lua._emscripten.removeFunction(this.functionWrapper)
        // Doesn't destroy the Lua thread, just function pointers.
        this.callbackContext.close()
        // Destroy the Lua thread
        this.callbackContext.lua.luaL_unref(this.callbackContext.address, LUA_REGISTRYINDEX, this.callbackContextIndex)
    }

    public isType(_t: Thread, _i: number, t: LuaType): boolean {
        return t === LuaType.Function
    }

    public pushValue(t: Thread, d: Decoration<FunctionType, FunctionDecoration>): boolean {
        if (typeof d.target !== 'function') {
            return false
        }

        // It's surprisingly inefficient to map JS functions to C functions so this creates a reference to the
        // function which stays solely in JS. The cfunction called from Lua is created at the top of the class
        // and it accesses the JS data through an upvalue.

        const pointer = t.lua.ref(d)
        // 4 = size of pointer in wasm.
        const userDataPointer = t.lua.lua_newuserdatauv(t.address, PointerSize, 0)
        t.lua._emscripten.setValue(userDataPointer, pointer, '*')

        if (LuaType.Nil === t.lua.luaL_getmetatable(t.address, this.name)) {
            // Pop the pushed userdata.
            t.pop(1)
            t.lua.unref(pointer)
            throw new Error(`metatable not found: ${this.name}`)
        }

        // Set as the metatable for the function.
        // -1 is the metatable, -2 is the userdata
        t.lua.lua_setmetatable(t.address, -2)

        // Pass 1 to associate the closure with the userdata, pops the userdata.
        t.lua.lua_pushcclosure(t.address, this.functionWrapper, 1)

        return true
    }

    public getValue(t: Thread, i: number): FunctionType {
        // Create a copy of the function
        t.lua.lua_pushvalue(t.address, i)
        // Create a reference to the function which pops it from the stack
        const func = t.lua.luaL_ref(t.address, LUA_REGISTRYINDEX)

        const jsFunc = (...args: any[]): any => {
            // Calling a function would ideally be in the Lua context that's calling it. For example if the JS function
            // setInterval were exposed to Lua then the calling thread would be created in that Lua context for executing
            // the function call back to Lua through JS. However, if getValue were called in a thread, the thread then
            // destroyed, and then this JS func were called it would be calling from a dead context. That means the safest
            // thing to do is to have a thread you know will always exist.
            if (this.callbackContext.isClosed()) {
                console.warn('Tried to call a function after closing lua state')
                return
            }

            // Function calls back to value should always be within a new thread because
            // they can be left in inconsistent states.
            const callThread = this.callbackContext.newThread()
            try {
                const internalType = callThread.lua.lua_rawgeti(callThread.address, LUA_REGISTRYINDEX, BigInt(func))
                if (internalType !== LuaType.Function) {
                    const callMetafieldType = callThread.lua.luaL_getmetafield(callThread.address, -1, '__call')
                    callThread.pop()
                    if (callMetafieldType !== LuaType.Function) {
                        throw new Error(`A value of type '${internalType}' was pushed but it is not callable`)
                    }
                }

                for (const arg of args) {
                    callThread.pushValue(arg)
                }

                if (this.options?.functionTimeout) {
                    callThread.setTimeout(Date.now() + this.options.functionTimeout)
                }

                const status: LuaReturn = callThread.lua.lua_pcallk(callThread.address, args.length, 1, 0, 0, null)
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

export default function createTypeExtension(
    t: Global,
    o?: FunctionTypeExtensionOptions,
): TypeExtension<FunctionType, FunctionDecoration> {
    return new FunctionTypeExtension(t, o)
}
