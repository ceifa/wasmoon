/**
 * Several values returned from one JS function, pushed as several Lua values rather than as a
 * single table.
 *
 * ```js
 * state.set('divide', (a, b) => MultiReturn.of(Math.floor(a / b), a % b))
 * ```
 */
export default class MultiReturn<T = any> extends Array<T> {
    /**
     * Nominal marker. Whether a returned array becomes several Lua values or one Lua table is
     * decided by `instanceof`, so the type has to be distinguishable from a plain array too. It is
     * declared rather than assigned, so nothing is added to the instance at runtime.
     */
    declare protected readonly multiReturn: undefined

    /**
     * Only the type differs from the inherited `Array.of`, which already constructs through `this`
     * and so already returns a MultiReturn.
     */
    declare public static of: <T>(...items: T[]) => MultiReturn<T>
}
