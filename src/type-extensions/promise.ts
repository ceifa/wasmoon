import { decorate, type Decoration } from '../decoration'
import type LuaState from '../state'
import MultiReturn from '../multireturn'
import RawResult from '../raw-result'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import type { LuaAddress } from '../types'
import { isPromise } from '../utils'
import { SUSPEND, type PendingAwait } from '../async'

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
     * One continuation for every await on this state. Building one per await meant compiling and
     * instantiating a wasm trampoline each time, and leaked the table slot whenever the coroutine
     * was abandoned before the continuation ran -- a run cut short by a deadline, say.
     */
    private readonly continuancePointer: number

    public constructor(state: LuaState, injectObject: boolean) {
        super(state, 'js_promise')

        this.continuancePointer = state.module.addFunction((continuanceState: LuaAddress): number => {
            const pending = state.getPendingAwait(continuanceState)
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
            state.clearPendingAwait(continuanceState)
            const continuanceThread = state.stateToThread(continuanceState)

            if (status === 'rejected') {
                return this.marshalRejected(continuanceThread, value)
            }
            return this.marshalResolved(continuanceThread, value)
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
                        // through a promising resume rather than a synchronous entry point (which
                        // `stackCanSuspend` is exactly true for).
                        if (module.useJspi && module.stackCanSuspend) {
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

                        const pending: PendingAwait = {
                            result: undefined,
                            promise: self.then(
                                (value) => {
                                    pending.result = { status: 'fulfilled', value }
                                    return value
                                },
                                (value) => {
                                    pending.result = { status: 'rejected', value }
                                },
                            ),
                        }
                        state.setPendingAwait(functionThread.address, pending)

                        // Host-driven awaits are registered out of band: no promise userdata or
                        // Lua stack value is needed. A manually resumed coroutine still receives
                        // its promise, preserving the low-level coroutine.resume contract.
                        let resultCount = 0
                        if (!functionThread.isRunning) {
                            functionThread.pushValue(pending.promise)
                            resultCount = 1
                        }
                        return new RawResult(module.lua_yieldk(functionThread.address, resultCount, 0, this.continuancePointer))
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
        // Captured now so a deadline or abort observed while parked interrupts the run rather than
        // waiting for the promise. Read from the resuming run, not this thread, whose JS wrapper is
        // often a fresh object without the run's limits on it.
        const run = this.state.module.activeRun!
        const { deadline, signal } = run.runLimits
        this.state.module.pendingSuspend = {
            run,
            promise,
            signal,
            deadline,
            isClosed: () => run.isClosed(),
            onResolve: (value: unknown) => this.marshalResolved(thread, value),
            onReject: (error: unknown) => this.marshalRejected(thread, error),
            onInterrupt: (error) => thread.interruptWith(error),
        }
        return SUSPEND
    }

    /** Pushes a settled promise value as Lua results and returns how many; `undefined` becomes nil. */
    private marshalResolved(thread: Thread, value: unknown): number {
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

    /** Raises a rejected promise as a Lua error on `thread`. */
    private marshalRejected(thread: Thread, error: unknown): number {
        thread.pushValue(error || new Error('promise rejected with no error'))
        return this.state.module.lua_error(thread.address)
    }
}

export default function createTypeExtension<T = unknown>(state: LuaState, injectObject: boolean): TypeExtension<Promise<T>> {
    return new PromiseTypeExtension<T>(state, injectObject)
}
