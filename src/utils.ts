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

/** Read by the build, which brands the glue's unwind classes with it. */
export const UNWIND_BRAND = '__emscriptenUnwind'

/**
 * A Lua longjmp out of a C function that a JS callback is on the stack of, which has to be rethrown
 * rather than turned into a Lua error. With `SUPPORT_LONGJMP=wasm` it is a `WebAssembly.Exception`
 * the wasm caller resumes unwinding from; the branded `EmscriptenEH` covers the other unwinds
 * Emscripten still throws from JS (its class is module local, hence the brand).
 */
export const isEmscriptenUnwind = (value: unknown): boolean => {
    if (typeof WebAssembly.Exception === 'function' && value instanceof WebAssembly.Exception) {
        return true
    }
    return (value as Record<string, unknown> | null | undefined)?.[UNWIND_BRAND] === true
}
