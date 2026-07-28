import { Decoration } from '../decoration'
import type LuaState from '../state'
import MultiReturn from '../multireturn'
import RawResult from '../raw-result'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import type { LuaAddress } from '../types'
import { isPromise } from '../utils'
import { decorate } from '../decoration'

class PromiseTypeExtension<T = unknown> extends TypeExtension<Promise<T>> {
    private gcPointer: number

    public constructor(state: LuaState, injectObject: boolean) {
        super(state, 'js_promise')

        this.gcPointer = this.createGcFunction()

        if (state.lua.luaL_newmetatable(state.address, this.name)) {
            const metatableIndex = state.lua.lua_gettop(state.address)

            // Mark it as uneditable
            state.lua.lua_pushstring(state.address, 'protected metatable')
            state.lua.lua_setfield(state.address, metatableIndex, '__metatable')

            // Add the gc function
            state.lua.lua_pushcclosure(state.address, this.gcPointer, 0)
            state.lua.lua_setfield(state.address, metatableIndex, '__gc')

            // A bare thenable reaches here too, and only `then` is guaranteed on one. Adopting it
            // into a real promise is what makes catch/finally/await work on it, and is a no-op for
            // the native promises that make up almost every case.
            const asPromise = (self: unknown): Promise<any> => {
                if (!isPromise(self)) {
                    throw new Error('self instance is not a promise')
                }
                return Promise.resolve(self)
            }

            state.pushValue({
                next: (self: unknown, ...args: Parameters<Promise<unknown>['then']>) => asPromise(self).then(...args),
                catch: (self: unknown, ...args: Parameters<Promise<unknown>['catch']>) => asPromise(self).catch(...args),
                finally: (self: unknown, ...args: Parameters<Promise<unknown>['finally']>) => asPromise(self).finally(...args),
                await: decorate(
                    (functionThread: Thread, rawSelf: unknown) => {
                        const self = asPromise(rawSelf)

                        // Asking Lua covers every non-resumable context, not just the main
                        // thread: anything entered through lua_pcall cannot yield either.
                        if (!state.lua.lua_isyieldable(functionThread.address)) {
                            throw new Error('cannot await in a thread that cannot yield, use doString instead of doStringSync')
                        }

                        let promiseResult: { status: 'fulfilled' | 'rejected'; value: any } | undefined = undefined

                        const awaitPromise = self
                            .then((res) => {
                                promiseResult = { status: 'fulfilled', value: res }
                                return res
                            })
                            .catch((err) => {
                                promiseResult = { status: 'rejected', value: err }
                            })

                        const continuance = this.state.lua._emscripten.addFunction((continuanceState: LuaAddress) => {
                            // If this yield has been called from within a coroutine and so manually resumed
                            // then there may not yet be any results. In that case yield again.
                            if (!promiseResult) {
                                // 1 is because the initial yield pushed a promise reference so this pops
                                // it and re-returns it.
                                // 0 because this is called between resumes so the first one should've
                                // popped the promise before returning the result. This is true within
                                // Lua's coroutine.resume too.
                                return state.lua.lua_yieldk(functionThread.address, 0, 0, continuance)
                            }

                            this.state.lua._emscripten.removeFunction(continuance)

                            const continuanceThread = state.stateToThread(continuanceState)

                            if (promiseResult.status === 'rejected') {
                                continuanceThread.pushValue(promiseResult.value || new Error('promise rejected with no error'))
                                return this.state.lua.lua_error(continuanceState)
                            }

                            if (promiseResult.value instanceof RawResult) {
                                return promiseResult.value.count
                            } else if (promiseResult.value instanceof MultiReturn) {
                                for (const arg of promiseResult.value) {
                                    continuanceThread.pushValue(arg)
                                }
                                return promiseResult.value.length
                            } else {
                                continuanceThread.pushValue(promiseResult.value)
                                return 1
                            }
                        }, 'iiii')

                        functionThread.pushValue(awaitPromise)
                        return new RawResult(state.lua.lua_yieldk(functionThread.address, 1, 0, continuance))
                    },
                    { receiveThread: true },
                ),
            })
            state.lua.lua_setfield(state.address, metatableIndex, '__index')

            state.pushValue((self: Promise<unknown>, other: Promise<unknown>) => self === other)
            state.lua.lua_setfield(state.address, metatableIndex, '__eq')
        }
        // Pop the metatable from the stack.
        state.lua.lua_pop(state.address, 1)

        if (injectObject) {
            // Lastly create a static Promise constructor.
            state.set('Promise', {
                create: (callback: ConstructorParameters<PromiseConstructor>[0]) => new Promise(callback),
                all: (promiseArray: any) => {
                    if (!Array.isArray(promiseArray)) {
                        throw new Error('argument must be an array of promises')
                    }

                    return Promise.all(promiseArray.map((potentialPromise) => Promise.resolve(potentialPromise)))
                },
                resolve: (value: any) => Promise.resolve(value),
            })
        }
    }

    public close(): void {
        this.state.lua._emscripten.removeFunction(this.gcPointer)
    }

    public pushValue(thread: Thread, decoration: Decoration<unknown>): boolean {
        if (!isPromise(decoration.target)) {
            return false
        }
        return super.pushValue(thread, decoration)
    }
}

export default function createTypeExtension<T = unknown>(state: LuaState, injectObject: boolean): TypeExtension<Promise<T>> {
    return new PromiseTypeExtension<T>(state, injectObject)
}
