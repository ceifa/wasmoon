/**
 * How a value should be marshalled into Lua.
 *
 * - `'userdata'` wraps it in an opaque userdata holding a JS reference, with no members exposed.
 * - `'proxy'` wraps it in a userdata whose metatable forwards index/call back into JS.
 * - `'value'` skips the proxy layer, so objects are copied into Lua tables and functions are
 *   pushed as plain Lua functions.
 *
 * Leaving it undefined keeps the default behaviour for the state's `objects` option.
 */
export type DecorationTarget = 'userdata' | 'proxy' | 'value'

export class Decoration<T = any> {
    public constructor(
        public target: T,
        public options: DecorationOptions,
    ) {}
}

export interface DecorationOptions {
    /** Metatable to attach to the pushed value, itself decoratable to control how it is pushed. */
    metatable?: Record<any, any> | Decoration
    as?: DecorationTarget
    /** Function only: bound as the receiver, and dropped from the argument list. */
    self?: any
    /** Function only: receives the calling thread as the first argument. */
    receiveThread?: boolean
    /**
     * Function only: receives the argument count instead of the decoded arguments, and is
     * expected to read the stack itself. This is a raw-level escape hatch.
     */
    receiveArgsQuantity?: boolean
}

/**
 * Attaches marshalling instructions to a value before pushing it into Lua.
 *
 * ```js
 * state.set('opaque', decorate(new Thing(), { as: 'userdata' }))
 * state.set('bound', decorate(thing.method, { self: thing }))
 * ```
 */
export function decorate<T = any>(target: T, options: DecorationOptions = {}): Decoration<T> {
    return new Decoration<T>(target, options)
}
