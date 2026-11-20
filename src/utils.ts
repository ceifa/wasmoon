/**
 * Any thenable, not just a native promise. Callers that need `catch`/`finally` rather than only
 * `await` have to normalise with `Promise.resolve` first.
 */
export const isPromise = (target: unknown): target is PromiseLike<unknown> => {
    // A `Promise.resolve(target) === target` identity check would also answer this, but it
    // allocates a promise for every value that turns out not to be one, and for a bare thenable it
    // calls the user's `then` just to find out.
    return typeof target === 'object' && target !== null && typeof (target as PromiseLike<unknown>).then === 'function'
}

/**
 * A Lua longjmp out of a C function that a JS callback is on the stack of, which has to be rethrown
 * rather than turned into a Lua error. With `SUPPORT_LONGJMP=wasm` it is a `WebAssembly.Exception`
 * the wasm caller resumes unwinding from, and the glue throws no unwind of its own from JS.
 */
export const isEmscriptenUnwind = (value: unknown): boolean => {
    return value instanceof WebAssembly.Exception
}
