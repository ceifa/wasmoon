import { BaseDecorationOptions, Decoration } from '../decoration'
import { LUA_REGISTRYINDEX, LuaReturn, LuaState, LuaType, PointerSize } from '../types'
import Global from '../global'
import MultiReturn from '../multireturn'
import Thread from '../thread'
import TypeExtension from '../type-extension'

export interface FunctionDecoration extends BaseDecorationOptions {
    rawArguments?: number[]
    receiveThread?: boolean
    rawResult?: boolean
}

export type FunctionType = (...args: any[]) => Promise<any> | any

export function decorateFunction(target: FunctionType, options: FunctionDecoration): Decoration<FunctionType, FunctionDecoration> {
    return new Decoration<FunctionType, FunctionDecoration>(target, options)
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

    public constructor(thread: Global) {
        super(thread, 'js_function')

        if (!this.functionRegistry) {
            console.warn('FunctionTypeExtension: FinalizationRegistry not found. Memory leaks likely.')
        }

        this.gcPointer = thread.lua.module.addFunction((calledL: LuaState) => {
            // Throws a lua error which does a jump if it does not match.
            const userDataPointer = thread.lua.luaL_checkudata(calledL, 1, this.name)
            const functionPointer = thread.lua.module.getValue(userDataPointer, '*')
            // Safe to do without a reference count because each time a function is pushed it creates a new and unique
            // anonymous function.
            thread.lua.module.removeFunction(functionPointer)

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
    }

    public close(): void {
        this.thread.lua.module.removeFunction(this.gcPointer)
    }

    public isType(_thread: Thread, _index: number, type: LuaType): boolean {
        return type === LuaType.Function
    }

    public pushValue(thread: Thread, decoratedValue: Decoration<FunctionType, FunctionDecoration>): boolean {
        const { target, options } = decoratedValue
        if (typeof target !== 'function') {
            return false
        }

        const pointer = thread.lua.module.addFunction((calledL: LuaState) => {
            const calledThread = thread.stateToThread(calledL)

            const argsQuantity = calledThread.getTop()
            const args = []

            if (options.receiveThread) {
                args.push(calledThread)
            }

            for (let i = 1; i <= argsQuantity; i++) {
                if (options.rawArguments?.includes(i - 1)) {
                    args.push(calledThread.getPointer(i))
                } else {
                    args.push(calledThread.getValue(i))
                }
            }

            if (options.rawResult) {
                // Interestingly yieldk does a longjmp and that's handled
                // by throwing an error. So for anything that yields it needs
                // to not be in the try/catch.
                const result = target(...args)
                if (typeof result !== 'number') {
                    throw new Error('result must be a number')
                }
                return result
            }

            try {
                const result = target(...args)

                if (result === undefined) {
                    return 0
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
                calledThread.pushValue(err)
                return calledThread.lua.lua_error(calledThread.address)
            }
        }, 'ii')
        // Creates a new userdata with metatable pointing to the function pointer.
        // Pushes the new userdata onto the stack.
        this.createAndPushFunctionReference(thread, pointer)
        // Pass 1 to associate the closure with the userdata.
        thread.lua.lua_pushcclosure(thread.address, pointer, 1)

        return true
    }

    public getValue(thread: Thread, index: number): FunctionType {
        thread.lua.lua_pushvalue(thread.address, index)
        const func = thread.lua.luaL_ref(thread.address, LUA_REGISTRYINDEX)

        const jsFunc = (...args: any[]): any => {
            if (thread.isClosed()) {
                console.warn('Tried to call a function after closing lua state')
                return
            }

            const internalType = thread.lua.lua_rawgeti(thread.address, LUA_REGISTRYINDEX, func)
            if (internalType !== LuaType.Function) {
                throw new Error(`A function of type '${internalType}' was pushed, expected is ${LuaType.Function}`)
            }

            for (const arg of args) {
                thread.pushValue(arg)
            }

            thread.lua.lua_callk(thread.address, args.length, 1, 0, null)
            const result = thread.getValue(-1)

            thread.pop()
            return result
        }

        this.functionRegistry?.register(jsFunc, func)

        return jsFunc
    }

    private createAndPushFunctionReference(thread: Thread, pointer: number): void {
        // 4 = size of pointer in wasm.
        const userDataPointer = thread.lua.lua_newuserdatauv(thread.address, PointerSize, 0)
        thread.lua.module.setValue(userDataPointer, pointer, '*')

        if (LuaType.Nil === thread.lua.luaL_getmetatable(thread.address, this.name)) {
            // Pop the pushed nil value and user data
            thread.pop(2)
            throw new Error(`metatable not found: ${this.name}`)
        }

        // Set as the metatable for the userdata.
        // -1 is the metatable, -2 is the user data.
        thread.lua.lua_setmetatable(thread.address, -2)
    }
}

export default function createTypeExtension(thread: Global): TypeExtension<FunctionType, FunctionDecoration> {
    return new FunctionTypeExtension(thread)
}
