import { decorate, type Decoration } from '../decoration'
import type LuaState from '../state'
import MultiReturn from '../multireturn'
import RawResult from '../raw-result'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import { type LuaAddress, LuaAbortError, LuaTimeoutError } from '../types'
import { isPromise } from '../utils'
import { SUSPEND } from '../async'

/** The half of an in flight `:await()` the continuation needs once the promise has settled. */
interface PendingAwait {
    result: { status: 'fulfilled' | 'rejected'; value: any } | undefined
}

/**
 * A bare thenable reaches here too, and only `then` is guaranteed on one. Adopting it into a real
 * promise is what makes catch/finally/await work on it, and is a no-op for the native promises
 * that make up almost every case.
 */
const asPromise = (self: unknown): Promise<any> => {
    if (!isPromise(self)) {
        throw new Error('self instance is not a promise')
    }
    return Promise.resolve(self)
}

class PromiseTypeExtension<T = unknown> extends TypeExtension<Promise<T>> {
    /**
     * Keyed by the address of the thread parked in the await. A thread suspended in `lua_yieldk`
     * cannot reach another `:await()`, so at most one is ever in flight per thread.
     */
    private readonly pendingAwaits = new Map<LuaAddress, PendingAwait>()
    /**
     * One continuation for every await on this state. Building one per await meant compiling and
     * instantiating a wasm trampoline each time, and leaked the table slot whenever the coroutine
     * was abandoned before the continuation ran -- a run cut short by a deadline, say.
     */
    private readonly continuancePointer: number

    public constructor(state: LuaState, injectObject: boolean) {
        super(state, 'js_promise')

        this.continuancePointer = state.module.addFunction((continuanceState: LuaAddress): number => {
            const pending = this.pendingAwaits.get(continuanceState)
            if (!pending) {
                // Nothing sensible is left to resume with, and returning would hand Lua a stack it
                // does not expect.
                throw new Error('a promise continuation ran without a pending await')
            }

            // If this yield has been called from within a coroutine and so manually resumed
            // then there may not yet be any results. In that case yield again. The continuation
            // runs on the thread that yielded, so this is the address the await parked on.
            if (!pending.result) {
                // 0 because this is called between resumes so the first one should've popped the
                // promise before returning the result. This is true within Lua's coroutine.resume
                // too.
                return state.module.lua_yieldk(continuanceState, 0, 0, this.continuancePointer)
            }

            const { status, value } = pending.result
            this.pendingAwaits.delete(continuanceState)
            const continuanceThread = state.stateToThread(continuanceState)

            if (status === 'rejected') {
                continuanceThread.pushValue(value || new Error('promise rejected with no error'))
                return state.module.lua_error(continuanceState)
            }

            if (value instanceof RawResult) {
                return value.count
            } else if (value instanceof MultiReturn) {
                for (const arg of value) {
                    continuanceThread.pushValue(arg)
                }
                return value.length
            } else {
                continuanceThread.pushValue(value)
                return 1
            }
        }, 'iiii')

        this.defineMetatable({
            // A plain object, which the table extension (registered before this one) copies into a
            // Lua table of methods.
            __index: {
                next: (self: unknown, ...args: Parameters<Promise<unknown>['then']>) => asPromise(self).then(...args),
                catch: (self: unknown, ...args: Parameters<Promise<unknown>['catch']>) => asPromise(self).catch(...args),
                finally: (self: unknown, ...args: Parameters<Promise<unknown>['finally']>) => asPromise(self).finally(...args),
                await: decorate(
                    (functionThread: Thread, rawSelf: unknown) => {
                        const self = asPromise(rawSelf)
                        const module = state.module

                        // Under JSPI an await can suspend the wasm stack from anywhere, including a
                        // C-call boundary a yield could not cross, so long as the run reached here
                        // through a promising resume rather than a synchronous entry point.
                        if (module.useJspi && module.stackCanSuspend && module.syncDepth === 0) {
                            return this.suspend(functionThread, self)
                        }

                        // Otherwise it can only park by yielding the coroutine, which a thread
                        // entered through lua_pcall (doStringSync, a JS→Lua callback) cannot do.
                        if (!module.lua_isyieldable(functionThread.address)) {
                            throw new Error(
                                module.useJspi
                                    ? 'cannot await here: a synchronous call is on the stack, use doString instead of doStringSync'
                                    : 'cannot await across a C-call boundary without JSPI; run this through doString',
                            )
                        }

                        const pending: PendingAwait = { result: undefined }
                        this.pendingAwaits.set(functionThread.address, pending)

                        const awaitPromise = self
                            .then((res) => {
                                pending.result = { status: 'fulfilled', value: res }
                                return res
                            })
                            .catch((err) => {
                                pending.result = { status: 'rejected', value: err }
                            })

                        // 1 result, because the yield hands the promise reference back so the
                        // resume that follows can wait on it.
                        functionThread.pushValue(awaitPromise)
                        return new RawResult(module.lua_yieldk(functionThread.address, 1, 0, this.continuancePointer))
                    },
                    { receiveThread: true },
                ),
            },
            __eq: (self: Promise<unknown>, other: Promise<unknown>) => self === other,
        })

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

    public override close(): void {
        super.close()
        this.state.module.removeFunction(this.continuancePointer)
        // A coroutine abandoned mid await never reaches its continuation, so its record is still
        // here holding whatever the promise settled with. Nothing tells us when Lua's own GC took
        // that coroutine, so these are bounded by the state's lifetime rather than the await's.
        this.pendingAwaits.clear()
    }

    public pushValue(thread: Thread, decoration: Decoration<unknown>): boolean {
        if (!isPromise(decoration.target)) {
            return false
        }
        return super.pushValue(thread, decoration)
    }

    /**
     * The JSPI await. It hands the promise and how to marshal its result to the module's await
     * hook, then returns the sentinel that makes the C trampoline reach that hook and suspend the
     * wasm stack. The stack unwinds to the promising resume driving the run and resumes there once
     * the promise settles, so nothing here yields the Lua coroutine.
     */
    private suspend(thread: Thread, promise: Promise<unknown>): typeof SUSPEND {
        const marshal = (value: unknown): number => {
            if (value instanceof RawResult) {
                return value.count
            }
            if (value instanceof MultiReturn) {
                for (const item of value) {
                    thread.pushValue(item)
                }
                return value.length
            }
            thread.pushValue(value)
            return 1
        }

        // Captured now so a deadline or abort observed while parked interrupts the run rather than
        // waiting for the promise. Read from the resuming run, not this thread, whose JS wrapper is
        // often a fresh object without the run's limits on it.
        const deadline = this.state.module.activeRunDeadline
        const signal = this.state.module.activeRunSignal
        this.state.module.pendingSuspend = {
            promise,
            signal,
            deadline,
            isClosed: () => thread.isClosed(),
            onResolve: marshal,
            onReject: (error: unknown): number => {
                thread.pushValue(error || new Error('promise rejected with no error'))
                return this.state.module.lua_error(thread.address)
            },
            onInterrupt: (): number => {
                const error =
                    signal?.aborted === true ? new LuaAbortError('thread aborted') : new LuaTimeoutError('thread timeout exceeded')
                return thread.interruptWith(thread.address, error)
            },
        }
        return SUSPEND
    }
}

export default function createTypeExtension<T = unknown>(state: LuaState, injectObject: boolean): TypeExtension<Promise<T>> {
    return new PromiseTypeExtension<T>(state, injectObject)
}
