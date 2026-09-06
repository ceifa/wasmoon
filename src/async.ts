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
    if (typeof MessageChannel === 'function') {
        const channel = new MessageChannel()
        const queue: Array<() => void> = []
        channel.port1.onmessage = () => queue.shift()?.()
        // Node keeps the event loop alive for an open port, which would stop a process exiting once
        // its Lua work is done; unref lets it exit. A no-op in the browser, which has neither.
        ;(channel.port1 as { unref?: () => void }).unref?.()
        ;(channel.port2 as { unref?: () => void }).unref?.()
        return (task: () => void) => {
            queue.push(task)
            channel.port2.postMessage(null)
        }
    }
    if (typeof setImmediate === 'function') {
        return (task: () => void) => void setImmediate(task)
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
    if (deadline !== undefined && Date.now() > deadline) {
        return new LuaTimeoutError('thread timeout exceeded')
    }
    return undefined
}

/**
 * Awaits `promise` but resolves early if `signal` aborts or `deadline` passes, so a run parked on a
 * long promise can still be interrupted rather than waiting for it to settle. The abandoned promise
 * is left to settle on its own and its result ignored.
 */
export function awaitInterruptible(
    promise: PromiseLike<unknown>,
    signal: AbortSignal | undefined,
    deadline: number | undefined,
): Promise<void> {
    return settleOrInterrupt(promise, signal, deadline).then(NOOP)
}

const NOOP = (): void => undefined

export type SettleOutcome =
    | { interrupted: false; resolved: true; value: unknown }
    | { interrupted: false; resolved: false; error: unknown }
    | { interrupted: true }

/**
 * Awaits `promise`, but reports an interruption instead if `signal` aborts or `deadline` passes
 * first. Used by the JSPI await hook, which unwinds the suspended run with a Lua error when it is
 * interrupted rather than waiting for the promise it was parked on.
 */
export function settleOrInterrupt(
    promise: PromiseLike<unknown>,
    signal: AbortSignal | undefined,
    deadline: number | undefined,
): Promise<SettleOutcome> {
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
        if (deadline !== undefined) {
            timer = setTimeout(() => finish({ interrupted: true }), Math.max(0, deadline - Date.now()))
        }

        let onAbort: (() => void) | undefined
        if (signal !== undefined) {
            if (signal.aborted) {
                finish({ interrupted: true })
                return
            }
            onAbort = () => finish({ interrupted: true })
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
