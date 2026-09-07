/**
 * A macrotask, so pending promise reactions *and* timers get a turn before Lua is resumed. A
 * microtask would starve timer driven code such as setTimeout based sleeps.
 *
 * MessageChannel where it exists, because a browser clamps a nested setTimeout to 4ms while a
 * message post is not clamped; setImmediate under Node; setTimeout as the last resort.
 */
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

export const yieldToEventLoop = (): Promise<void> => {
    return new Promise((resolve) => macrotask(resolve))
}

/**
 * The interrupt a deadline or aborted signal calls for, or undefined when neither has fired. The
 * single source of both the abort-vs-timeout classification and its message, shared by the debug
 * hook's limit check and the JSPI await hook.
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
    | { interrupted: false; resolved: true; value: unknown }
    | { interrupted: false; resolved: false; error: unknown }
    | { interrupted: true; error: LuaInterruptError }

/**
 * Awaits `promise`, but reports an interruption instead if `signal` aborts or `deadline` passes
 * first. Used by the JSPI await hook, which unwinds the suspended run with a Lua error when it is
 * interrupted rather than waiting for the promise it was parked on.
 */
export function settleOrInterrupt(promise: unknown, signal: AbortSignal | undefined, deadline: number | undefined): Promise<SettleOutcome> {
    const settled: Promise<SettleOutcome> = Promise.resolve(promise).then(
        (value) => ({ interrupted: false, resolved: true, value }),
        (error) => ({ interrupted: false, resolved: false, error }),
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
                        finish({ interrupted: true, error })
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
                finish({ interrupted: true, error: new LuaAbortError('thread aborted') })
                return
            }
            onAbort = () => finish({ interrupted: true, error: new LuaAbortError('thread aborted') })
            signal.addEventListener('abort', onAbort, { once: true })
        }

        settled.then(finish)
    })
}

/**
 * Returned by a JS function through the C trampoline to ask it to suspend the JSPI stack. The
 * function extension turns it into the -1 the trampoline reads; nothing else produces it.
 */
export const SUSPEND: unique symbol = Symbol('wasmoon.suspend')

/** One record per coroutine await, shared by the continuation and its host driver. */
export interface PendingAwait {
    promise: Promise<unknown>
    result: { status: 'fulfilled' | 'rejected'; value: unknown } | undefined
}
