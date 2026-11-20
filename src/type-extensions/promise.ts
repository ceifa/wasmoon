import { copy, type LuaRawFunction, raw } from '../marshal'
import type LuaState from '../state'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import { isPromise } from '../utils'
import { SUSPEND } from '../async'

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

/** What a promise calls once it settles: a callback from Lua or JS, or nothing. */
type Reaction = ((...args: any[]) => unknown) | null | undefined

/** Why an `:await()` reached outside a suspendable run fails, for a platform with JSPI and one without. */
const SYNCHRONOUS_AWAIT =
    'cannot await inside a synchronous call: run the script with doString, or make the function asynchronous with async(fn) in Lua or state.async(fn) in JS'
const UNSUPPORTED_AWAIT =
    'cannot await: this platform has no WebAssembly JSPI support (it needs Chrome 137, Firefox 153, Safari 27 or Node.js 25, or newer)'

class PromiseTypeExtension<T = unknown> extends TypeExtension<Promise<T>> {
    public constructor(state: LuaState, injectObject: boolean) {
        super(state, 'js_promise')

        // A Lua function handed to a promise runs as a run of its own, so that it can await like the
        // async function it stands in for. Anything else is passed through as it is.
        const reaction = (callback: Reaction): Reaction => (state.isLuaFunction(callback) ? state.async(callback) : callback)

        this.deferMetatable(() => ({
            // A plain object, which a metatable copies into a Lua table of methods.
            __index: {
                next: (self: unknown, onFulfilled: Reaction, onRejected: Reaction) =>
                    asPromise(self).then(reaction(onFulfilled), reaction(onRejected)),
                catch: (self: unknown, onRejected: Reaction) => asPromise(self).catch(reaction(onRejected)),
                finally: (self: unknown, onFinally: Reaction) => asPromise(self).finally(reaction(onFinally)),
                // Raw for the thread it is called on, which is where the settled value has to go.
                await: raw(((functionThread: Thread) => {
                    const self = asPromise(functionThread.getValue(1))
                    if (!state.module.stackCanSuspend) {
                        throw new Error(state.module.jspiSupported ? SYNCHRONOUS_AWAIT : UNSUPPORTED_AWAIT)
                    }
                    return this.suspend(functionThread, self)
                }) as unknown as LuaRawFunction),
            },
            __eq: (self: Promise<unknown>, other: Promise<unknown>) => self === other,
        }))

        if (injectObject) {
            // Lastly create a static Promise constructor.
            state.set(
                'Promise',
                copy({
                    create: (callback: ConstructorParameters<PromiseConstructor>[0]) => new Promise(callback),
                    all: (promiseArray: any) => {
                        if (!Array.isArray(promiseArray)) {
                            throw new Error('argument must be an array of promises')
                        }

                        return Promise.all(promiseArray.map((potentialPromise) => Promise.resolve(potentialPromise)))
                    },
                    resolve: (value: any) => Promise.resolve(value),
                }),
            )
        }
    }

    public push(thread: Thread, promise: PromiseLike<unknown>): void {
        this.pushReference(thread, promise)
    }

    /**
     * Hands the promise and how to marshal its result to the module's await hook, then returns the
     * sentinel that makes the C trampoline reach that hook and suspend the wasm stack.
     */
    private suspend(thread: Thread, promise: Promise<unknown>): typeof SUSPEND {
        // Read from the run being resumed, not this thread, whose JS wrapper is often a fresh object
        // without the run's limits on it.
        const run = this.state.module.activeRun!
        const { deadline, signal } = run.runLimits
        this.state.module.pendingSuspend = {
            run,
            promise,
            signal,
            deadline,
            resume: (outcome) => {
                if (outcome.status === 'interrupted') {
                    return thread.interruptWith(outcome.error)
                }
                return outcome.status === 'fulfilled'
                    ? thread.pushReturnValues(outcome.value, true)
                    : this.marshalRejected(thread, outcome.error)
            },
        }
        return SUSPEND
    }

    private marshalRejected(thread: Thread, error: unknown): number {
        thread.pushValue(error || new Error('promise rejected with no error'))
        return this.state.module.lua_error(thread.address)
    }
}

export default function createTypeExtension(state: LuaState, injectObject: boolean): PromiseTypeExtension {
    return new PromiseTypeExtension(state, injectObject)
}
export type { PromiseTypeExtension }
