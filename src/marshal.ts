import type Thread from './thread'

/** How a {@link LuaMarshalled} value crosses into Lua. `'method'` is the proxy's own, never handed out. */
export type LuaMarshalMode = 'copy' | 'proxy' | 'opaque' | 'raw' | 'method'

/**
 * A value together with how it crosses into Lua, made by {@link copy}, {@link proxy},
 * {@link opaque} or {@link raw}. Without one a value crosses the way its type does by default.
 */
export class LuaMarshalled<T = unknown> {
    public constructor(
        public readonly target: T,
        public readonly as: LuaMarshalMode,
        /** `copy` only: see {@link LuaCopyOptions.metatable}. */
        public readonly metatable?: object,
    ) {}
}

export interface LuaCopyOptions {
    /**
     * A metatable for the Lua table the value is copied into, itself copied into a table unless it
     * is wrapped to say otherwise. Its functions are called with the Lua table read back into JS.
     */
    metatable?: object | undefined
}

/**
 * A function called the way Lua calls a C function: it reads its `argCount` arguments off the
 * thread's stack, pushes its results, and returns how many it pushed.
 */
export type LuaRawFunction = (thread: Thread, argCount: number) => number

const unwrap = <T>(value: T | LuaMarshalled<T>): T => (value instanceof LuaMarshalled ? value.target : value)

/**
 * Crosses into Lua as plain Lua data: an object or array becomes a table and so does everything
 * inside it, whatever the state's `objects` option says. What has a representation of its own
 * (a function, a promise, an `Error`, a defined type or class) keeps it.
 *
 * ```js
 * state.set('config', copy({ retries: 3, hosts: ['a', 'b'] }))
 * ```
 */
export function copy<T>(value: T, options?: LuaCopyOptions): LuaMarshalled<T> {
    return new LuaMarshalled(unwrap(value), 'copy', options?.metatable)
}

/**
 * Crosses into Lua by reference, as a userdata that forwards indexing, assignment, calls, `#` and
 * `pairs` to the JS value. The default for an object when the state's `objects` is `'proxy'`, and
 * the way to make a function indexable: its properties are reachable, and `fn.new(...)` constructs.
 *
 * ```js
 * state.set('Date', proxy(Date)) // Date.now(), Date.new(0):toISOString()
 * ```
 */
export function proxy<T extends object>(value: T): LuaMarshalled<T> {
    return new LuaMarshalled(unwrap(value), 'proxy')
}

/**
 * Crosses into Lua by reference with nothing reachable: a userdata Lua can hold, compare and hand
 * back, which reads back as the same JS value.
 */
export function opaque<T extends object>(value: T): LuaMarshalled<T> {
    return new LuaMarshalled(unwrap(value), 'opaque')
}

/**
 * Crosses into Lua as a function that works on the stack itself, for what the marshalling of
 * arguments and results cannot express or cannot afford.
 *
 * ```js
 * state.set('swap', raw((thread) => {
 *     thread.module.lua_rotate(thread.address, 1, 1)
 *     return 2
 * }))
 * ```
 */
export function raw(fn: LuaRawFunction): LuaMarshalled<LuaRawFunction> {
    if (typeof fn !== 'function') {
        throw new TypeError('raw expects a function')
    }
    return new LuaMarshalled(fn, 'raw')
}

/**
 * A function a proxy handed out for one of its target's members. It is called on that target
 * however Lua called it, so `obj.method(x)` and `obj:method(x)` both reach `obj.method(x)`: the
 * receiver a `:` call passes ahead of the arguments is dropped.
 */
export class BoundMethod extends LuaMarshalled<(...args: any[]) => unknown> {
    public constructor(
        target: (...args: any[]) => unknown,
        public readonly self: object,
    ) {
        super(target, 'method')
    }
}
