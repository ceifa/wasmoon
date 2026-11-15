/**
 * A macrotask, so pending promise reactions *and* timers get a turn before Lua is resumed. A
 * microtask would starve timer driven code such as setTimeout based sleeps.
 *
 * MessageChannel where it exists, because a browser clamps a nested setTimeout to 4ms while a
 * message post is not clamped; setImmediate under Node; setTimeout as the last resort.
 */
import type Thread from './thread'
import { LuaAbortError, type LuaInterruptError, LuaTimeoutError } from './types'

type Macrotask = (task: () => void) => void

const macrotask: Macrotask = (() => {
    if (typeof setImmediate === 'function') {
        return (task: () => void) => void setImmediate(task)
    }
    if (typeof MessageChannel === 'function') {
        const channel = new MessageChannel()
        const queue: Array<() => void> = []
        channel.port1.onmessage = () => queue.shift()?.()
        return (task: () => void) => {
            queue.push(task)
            channel.port2.postMessage(null)
        }
    }
    return (task: () => void) => void setTimeout(task, 0)
})()

/**
 * Whether the platform has JSPI (the WebAssembly JavaScript Promise Integration API), which is what
 * lets an `:await()` suspend the wasm stack.
 */
export const canSuspend = (): boolean => typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function'

/** A promise that knows whether anything has asked for its outcome. */
class ObservedPromise extends Promise<unknown> {
    // What `then` derives is an ordinary promise, with nobody to report to.
    public static override get [Symbol.species](): PromiseConstructor {
        return Promise
    }

    public observed = false

    public override then<A, B>(
        onFulfilled?: ((value: unknown) => A | PromiseLike<A>) | null,
        onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ): Promise<A | B> {
        this.observed = true
        return super.then(onFulfilled, onRejected)
    }
}

/**
 * Follows `run`, and hands its failure to `report` when nothing turned out to be waiting for it.
 * With that the failure is never an unhandled rejection, which is the host's to decide about and
 * in Node ends the process.
 */
export function reportIfUnobserved(run: Promise<unknown>, report: (error: unknown) => void): Promise<unknown> {
    const promise = new ObservedPromise((resolve, reject) => void run.then(resolve, reject))
    // Through the prototype: the promise's own `then` would count this as somebody waiting.
    void Promise.prototype.then.call(promise, undefined, async (error: unknown) => {
        // Whoever was handed the promise gets until the event loop turns to start waiting on it.
        await yieldToEventLoop()
        if (!promise.observed) {
            report(error)
        }
    })
    return promise
}

export const yieldToEventLoop = (): Promise<void> => {
    return new Promise((resolve) => macrotask(resolve))
}

/**
 * The interrupt a deadline or aborted signal calls for, or undefined when neither has fired. The
 * single source of both the abort-vs-timeout classification and its message, shared by the debug
 * hook's limit check and the await hook.
 */
export function limitError(signal: AbortSignal | undefined, deadline: number | undefined): LuaInterruptError | undefined {
    if (signal?.aborted) {
        return new LuaAbortError('thread aborted')
    }
    if (deadline !== undefined && Date.now() >= deadline) {
        return new LuaTimeoutError('thread timeout exceeded')
    }
    return undefined
}

export type SettleOutcome =
    | { status: 'fulfilled'; value: unknown }
    | { status: 'rejected'; error: unknown }
    | { status: 'interrupted'; error: LuaInterruptError }

/**
 * The promise an `:await()` stashed for the C trampoline's await hook to suspend on, along
 * with how to marshal its settled value back onto the Lua stack.
 */
export interface PendingSuspend {
    run: Thread
    promise: PromiseLike<unknown>
    signal: AbortSignal | undefined
    deadline: number | undefined
    resume: (outcome: SettleOutcome) => number
}

/**
 * Awaits `promise`, but reports an interruption instead if `signal` aborts or `deadline` passes
 * first. Used for an `onYield` handler, and by the await hook, which unwinds the suspended run with
 * a Lua error when it is interrupted rather than waiting for the promise it was parked on.
 */
export function settleOrInterrupt(promise: unknown, signal: AbortSignal | undefined, deadline: number | undefined): Promise<SettleOutcome> {
    const settled: Promise<SettleOutcome> = Promise.resolve(promise).then(
        (value) => ({ status: 'fulfilled', value }),
        (error) => ({ status: 'rejected', error }),
    )
    if (signal === undefined && deadline === undefined) {
        return settled
    }

    return new Promise<SettleOutcome>((resolve) => {
        let done = false
        const finish = (outcome: SettleOutcome): void => {
            if (done) {
                return
            }
            done = true
            if (timer !== undefined) {
                clearTimeout(timer)
            }
            if (onAbort !== undefined) {
                signal?.removeEventListener('abort', onAbort)
            }
            resolve(outcome)
        }

        let timer: ReturnType<typeof setTimeout> | undefined
        const scheduleDeadline = (): void => {
            if (deadline === undefined) {
                return
            }
            // Timers can fire early and delays above 2^31-1 overflow to 1ms in Node.
            timer = setTimeout(
                () => {
                    const error = limitError(signal, deadline)
                    if (error) {
                        finish({ status: 'interrupted', error })
                    } else {
                        scheduleDeadline()
                    }
                },
                Math.min(0x7fffffff, Math.max(0, deadline - Date.now())),
            )
        }
        scheduleDeadline()

        let onAbort: (() => void) | undefined
        if (signal !== undefined) {
            if (signal.aborted) {
                finish({ status: 'interrupted', error: new LuaAbortError('thread aborted') })
                return
            }
            onAbort = () => finish({ status: 'interrupted', error: new LuaAbortError('thread aborted') })
            signal.addEventListener('abort', onAbort, { once: true })
        }

        settled.then(finish)
    })
}

/**
 * Returned by a JS function through the C trampoline to ask it to suspend the wasm stack. The
 * function extension turns it into the -1 the trampoline reads; nothing else produces it.
 */
export const SUSPEND: unique symbol = Symbol('wasmoon.suspend')
