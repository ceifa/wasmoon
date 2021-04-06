import { LuaReturn, LuaState } from '../types'
import { decorateFunction } from '../decoration'
import Thread from '../thread'
import TypeExtension from '../type-extension'

class PromiseTypeExtension<T = unknown> extends TypeExtension<Promise<T>> {
    private gcPointer: number

    public constructor(thread: Thread, injectObject: boolean) {
        super(thread, 'js_promise')

        this.gcPointer = thread.cmodule.module.addFunction((functionStateAddress: LuaState) => {
            // Throws a lua error which does a jump if it does not match.
            const userDataPointer = thread.cmodule.luaL_checkudata(functionStateAddress, 1, this.name)
            const referencePointer = thread.cmodule.module.getValue(userDataPointer, '*')
            thread.cmodule.unref(referencePointer)

            return LuaReturn.Ok
        }, 'ii')

        if (thread.cmodule.luaL_newmetatable(thread.address, this.name)) {
            const metatableIndex = thread.cmodule.lua_gettop(thread.address)

            // Mark it as uneditable
            thread.cmodule.lua_pushstring(thread.address, 'protected metatable')
            thread.cmodule.lua_setfield(thread.address, metatableIndex, '__metatable')

            // Add the gc function
            thread.cmodule.lua_pushcclosure(thread.address, this.gcPointer, 0)
            thread.cmodule.lua_setfield(thread.address, metatableIndex, '__gc')

            thread.pushValue({
                next: (self: Promise<unknown>, ...args: any[]) => {
                    if (Promise.resolve(self) !== self) {
                        throw new Error('promise has no instance data')
                    }
                    return self.then(...args)
                },
                catch: (self: Promise<unknown>, ...args: any[]) => {
                    if (Promise.resolve(self) !== self) {
                        throw new Error('promise has no instance data')
                    }
                    return self.catch(...args)
                },
                finally: (self: Promise<unknown>, ...args: any[]) => {
                    if (Promise.resolve(self) !== self) {
                        throw new Error('promise has no instance data')
                    }
                    return self.finally(...args)
                },
                await: decorateFunction(
                    (functionThread: Thread, self: Promise<any>) => {
                        if (Promise.resolve(self) !== self) {
                            throw new Error('promise has no instance data')
                        }
                        let promiseResult: { status: 'fulfilled' | 'rejected'; value: any } | undefined = undefined

                        const awaitPromise = self
                            .then((res) => {
                                promiseResult = { status: 'fulfilled', value: res }
                            })
                            .catch((err) => {
                                promiseResult = { status: 'rejected', value: err }
                            })

                        const continuance = this.thread.cmodule.module.addFunction((continuanceState: LuaState) => {
                            // If this yield has been called from within a coroutine and so manually resumed
                            // then there may not yet be any results. In that case yield again.
                            if (!promiseResult) {
                                // 1 is because the initial yield pushed a promise reference so this pops
                                // it and re-returns it.
                                // 0 because this is called between resumes so the first one should've
                                // popped the promise before returning the result. This is true within
                                // Lua's coroutine.resume too.
                                return thread.cmodule.lua_yieldk(functionThread.address, 0, 0, continuance)
                            }

                            thread.cmodule.module.removeFunction(continuance)
                            const continuanceThread = thread.stateToThread(continuanceState)

                            if (!promiseResult) {
                                promiseResult = { status: 'rejected', value: new Error('continuance called with no result') }
                            }

                            if (promiseResult.status === 'rejected') {
                                continuanceThread.pushValue(promiseResult.value || new Error('promise rejected with no error'))
                                return this.thread.cmodule.lua_error(continuanceState)
                            }

                            continuanceThread.pushValue(promiseResult.value)
                            return 1
                        }, 'iiii')

                        functionThread.pushValue(awaitPromise)
                        return thread.cmodule.lua_yieldk(functionThread.address, 1, 0, continuance)
                    },
                    { receiveThread: true, rawResult: true },
                ),
            })
            thread.cmodule.lua_setfield(thread.address, metatableIndex, '__index')
        }
        // Pop the metatable from the stack.
        thread.cmodule.lua_pop(thread.address, 1)

        if (injectObject) {
            // Lastly create a static Promise constructor.
            thread.set('Promise', {
                create: (callback: any) => {
                    if (callback && typeof callback !== 'function') {
                        throw new Error('callback must be a function')
                    }

                    return new Promise(callback)
                },
                all: (promiseArray: any) => {
                    if (!Array.isArray(promiseArray)) {
                        throw new Error('argument must be an array of promises')
                    }
                    return Promise.all(promiseArray.map((potentialPromise) => Promise.resolve(potentialPromise)))
                },
            })
        }
    }

    public close(): void {
        this.thread.cmodule.module.removeFunction(this.gcPointer)
    }

    public pushValue(thread: Thread, value: unknown): boolean {
        if (Promise.resolve(value) !== value) {
            return false
        }
        return super.pushValue(thread, value)
    }
}

export default function createTypeExtension<T = unknown>(thread: Thread, injectObject: boolean): TypeExtension<Promise<T>> {
    return new PromiseTypeExtension<T>(thread, injectObject)
}
