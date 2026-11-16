import type Thread from './thread'
import { type LuaInterruptError, LuaAbortError, LuaTimeoutError } from './types'

/**
 * setImmediate under Node. In a browser a MessageChannel, because a nested setTimeout is clamped to
 * 4ms there while a message post is not; setTimeout as the last resort.
 */
const macrotask: (task: () => void) => void = (() => {
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

/** Whether the platform has JSPI, which is what lets an `:await()` suspend the wasm stack. */
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

/**
 * A macrotask, so pending promise reactions *and* timers get a turn before Lua is resumed. A
 * microtask would starve timer driven code such as setTimeout based sleeps.
 */
export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => macrotask(resolve))

/** The interrupt a deadline or aborted signal calls for, or undefined when neither has fired. */
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

/** Awaits `promise`, but reports an interruption instead if `signal` aborts or `deadline` passes first. */
export function settleOrInterrupt(promise: unknown, signal: AbortSignal | undefined, deadline: number | undefined): Promise<SettleOutcome> {
    const settled: Promise<SettleOutcome> = Promise.resolve(promise).then(
        (value) => ({ status: 'fulfilled', value }),
        (error) => ({ status: 'rejected', error }),
    )
    if (signal === undefined && deadline === undefined) {
        return settled
    }

    return new Promise<SettleOutcome>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (outcome: SettleOutcome): void => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', check)
            resolve(outcome)
        }
        // A timer can fire early, and a delay above 2^31-1 overflows to 1ms in Node, so it is armed
        // again until the deadline has passed.
        const check = (): void => {
            const error = limitError(signal, deadline)
            if (error) {
                finish({ status: 'interrupted', error })
            } else if (deadline !== undefined) {
                timer = setTimeout(check, Math.min(0x7fffffff, deadline - Date.now()))
            }
        }
        signal?.addEventListener('abort', check, { once: true })
        check()
        void settled.then(finish)
    })
}

/**
 * Returned by a JS function through the C trampoline to ask it to suspend the wasm stack. The
 * function extension turns it into the -1 the trampoline reads; nothing else produces it.
 */
export const SUSPEND: unique symbol = Symbol('wasmoon.suspend')
