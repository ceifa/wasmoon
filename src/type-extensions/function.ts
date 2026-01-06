import { BaseDecorationOptions, Decoration } from '../decoration'
import Global from '../global'
import MultiReturn from '../multireturn'
import RawResult from '../raw-result'
import Thread from '../thread'
import TypeExtension from '../type-extension'
import { LUA_REGISTRYINDEX, LuaResumeResult, LuaReturn, LuaState, LuaType, PointerSize } from '../types'

export interface FunctionDecoration extends BaseDecorationOptions {
    receiveArgsQuantity?: boolean
    receiveThread?: boolean
    self?: any
}

export type FunctionType = (...args: any[]) => Promise<any> | any

export function decorateFunction(target: FunctionType, options: FunctionDecoration): Decoration<FunctionType, FunctionDecoration> {
    return new Decoration<FunctionType, FunctionDecoration>(target, options)
}

export interface FunctionTypeExtensionOptions {
    functionTimeout?: number
}

class FunctionTypeExtension extends TypeExtension<FunctionType, FunctionDecoration> {
    private readonly functionRegistry =
        typeof FinalizationRegistry !== 'undefined'
            ? new FinalizationRegistry((func: number) => {
                  if (!this.thread.isClosed()) {
                      this.thread.lua.luaL_unref(this.thread.address, LUA_REGISTRYINDEX, func)
                  }
              })
            : undefined

    private gcPointer: number
    private functionWrapper: number
    private callbackContext: Thread
    private callbackContextIndex: number
    private options?: FunctionTypeExtensionOptions

    public constructor(thread: Global, options?: FunctionTypeExtensionOptions) {
        super(thread, 'js_function')

        this.options = options
        // Create a thread off of the global thread to be used to create function call threads without
        // interfering with the global context. This creates a callback context that will always exist
        // even if the thread that called getValue() has been destroyed.
        this.callbackContext = thread.newThread()
        // Pops it from the global stack but keeps it alive
        this.callbackContextIndex = this.thread.lua.luaL_ref(thread.address, LUA_REGISTRYINDEX)

        if (!this.functionRegistry) {
            console.warn('FunctionTypeExtension: FinalizationRegistry not found. Memory leaks likely.')
        }

        this.gcPointer = thread.lua.module.addFunction((calledL: LuaState) => {
            // Throws a lua error which does a jump if it does not match.
            thread.lua.luaL_checkudata(calledL, 1, this.name)

            const userDataPointer = thread.lua.luaL_checkudata(calledL, 1, this.name)
            const referencePointer = thread.lua.module.getValue(userDataPointer, '*')
            thread.lua.unref(referencePointer)

            return LuaReturn.Ok
        }, 'ii')

        // Creates metatable if it doesn't exist, always pushes it onto the stack.
        if (thread.lua.luaL_newmetatable(thread.address, this.name)) {
            thread.lua.lua_pushstring(thread.address, '__gc')
            thread.lua.lua_pushcclosure(thread.address, this.gcPointer, 0)
            thread.lua.lua_settable(thread.address, -3)

            thread.lua.lua_pushstring(thread.address, '__metatable')
            thread.lua.lua_pushstring(thread.address, 'protected metatable')
            thread.lua.lua_settable(thread.address, -3)
        }
        // Pop the metatable from the stack.
        thread.lua.lua_pop(thread.address, 1)

        this.functionWrapper = thread.lua.module.addFunction((calledL: LuaState) => {
            const calledThread = thread.stateToThread(calledL)

            const refUserdata = thread.lua.luaL_checkudata(calledL, thread.lua.lua_upvalueindex(1), this.name)
            const refPointer = thread.lua.module.getValue(refUserdata, '*')
            const { target, options } = thread.lua.getRef(refPointer) as Decoration<FunctionType, FunctionDecoration>

            const argsQuantity = calledThread.getTop()
            const args = []

            if (options.receiveThread) {
                args.push(calledThread)
            }

            if (options.receiveArgsQuantity) {
                args.push(argsQuantity)
            } else {
                for (let i = 1; i <= argsQuantity; i++) {
                    const value = calledThread.getValue(i)
                    if (i !== 1 || !options?.self || value !== options.self) {
                        args.push(value)
                    }
                }
            }

            try {
                const result = target.apply(options?.self, args)

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
        this.thread.lua.module.removeFunction(this.gcPointer)
        this.thread.lua.module.removeFunction(this.functionWrapper)
        // Doesn't destroy the Lua thread, just function pointers.
        this.callbackContext.close()
        // Destroy the Lua thread
        this.callbackContext.lua.luaL_unref(this.callbackContext.address, LUA_REGISTRYINDEX, this.callbackContextIndex)
    }

    public isType(_thread: Thread, _index: number, type: LuaType): boolean {
        return type === LuaType.Function
    }

    public pushValue(thread: Thread, decoration: Decoration<FunctionType, FunctionDecoration>): boolean {
        if (typeof decoration.target !== 'function') {
            return false
        }

        // It's surprisingly inefficient to map JS functions to C functions so this creates a reference to the
        // function which stays solely in JS. The cfunction called from Lua is created at the top of the class
        // and it accesses the JS data through an upvalue.

        const pointer = thread.lua.ref(decoration)
        // 4 = size of pointer in wasm.
        const userDataPointer = thread.lua.lua_newuserdatauv(thread.address, PointerSize, 0)
        thread.lua.module.setValue(userDataPointer, pointer, '*')

        if (LuaType.Nil === thread.lua.luaL_getmetatable(thread.address, this.name)) {
            // Pop the pushed userdata.
            thread.pop(1)
            thread.lua.unref(pointer)
            throw new Error(`metatable not found: ${this.name}`)
        }

        // Set as the metatable for the function.
        // -1 is the metatable, -2 is the userdata
        thread.lua.lua_setmetatable(thread.address, -2)

        // Pass 1 to associate the closure with the userdata, pops the userdata.
        thread.lua.lua_pushcclosure(thread.address, this.functionWrapper, 1)

        return true
    }

    public getValue(thread: Thread, index: number): FunctionType {
        // Create a copy of the function
        thread.lua.lua_pushvalue(thread.address, index)
        // Create a reference to the function which pops it from the stack
        const func = thread.lua.luaL_ref(thread.address, LUA_REGISTRYINDEX)

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

                const resumeResult: LuaResumeResult = callThread.resume(args.length)
                if (resumeResult.result === LuaReturn.Yield) {
                    return new Promise((r, c) => {
                        callThread
                            .run(0)
                            .then(() => {
                                if (callThread.getTop() > 0) {
                                    r(callThread.getValue(-1))
                                    return
                                }
                                r(undefined)
                            })
                            .catch(c)
                    })
                }
                callThread.assertOk(resumeResult.result)

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
    thread: Global,
    options?: FunctionTypeExtensionOptions,
): TypeExtension<FunctionType, FunctionDecoration> {
    return new FunctionTypeExtension(thread, options)
}
