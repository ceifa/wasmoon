export const isPromise = (target: any): target is Promise<unknown> => {
    return target && (Promise.resolve(target) === target || typeof target.then === 'function')
}

/**
 * Emscripten unwinds a Lua longjmp by throwing from its internal EmscriptenEH hierarchy. The
 * wasm caller gates on `instanceof EmscriptenEH` to resume unwinding, so these have to be
 * rethrown rather than raised as Lua errors. The class is module local in the generated glue,
 * which leaves the name as the only usable signal.
 */
export const isEmscriptenUnwind = (value: unknown): boolean => {
    return typeof value === 'object' && value !== null && String(value.constructor?.name).startsWith('Emscripten')
}

// Browsers have no setImmediate. The 4ms clamp on nested timers is acceptable here.
const scheduleMacrotask = typeof setImmediate === 'function' ? setImmediate : (task: () => void) => setTimeout(task, 0)

/**
 * A macrotask, so pending promise callbacks *and* timers get a chance to run before Lua is
 * resumed. A microtask would starve timer driven code such as setTimeout based sleeps.
 */
export const yieldToEventLoop = (): Promise<void> => {
    return new Promise((resolve) => scheduleMacrotask(() => resolve()))
}
