import type LuaState from './state'
import { LUA_GC_PARAMS, type LuaGcMode, type LuaGcOptions, type LuaGcParam, LuaGcWhat } from './types'

/** The state's garbage collector, as `state.gc`: what `collectgarbage` offers, callable from JS. */
export default class LuaGarbageCollector {
    public constructor(
        private readonly state: LuaState,
        options?: LuaGcOptions,
    ) {
        if (options?.mode) {
            this.setMode(options.mode)
        }
        for (const name in options?.params) {
            this.param(name as LuaGcParam, options.params[name as LuaGcParam])
        }
    }

    public collect(): void {
        this.call(LuaGcWhat.Collect)
    }

    /**
     * Runs one incremental step, sized as if `bytes` had just been allocated. Zero forces a single
     * basic step.
     * @returns true when the step finished a collection cycle.
     */
    public step(bytes = 0): boolean {
        assertNonNegativeInteger('step size', bytes)
        return this.call(LuaGcWhat.Step, bytes) !== 0
    }

    /** Stops automatic collection until {@link restart}. Explicit calls still work. */
    public stop(): void {
        this.call(LuaGcWhat.Stop)
    }

    public restart(): void {
        this.call(LuaGcWhat.Restart)
    }

    public isRunning(): boolean {
        return this.call(LuaGcWhat.IsRunning) !== 0
    }

    /**
     * Bytes in use by the state, what `collectgarbage('count')` reports. Counts the same thing as
     * `state.memory.used` without needing the tracing allocator.
     */
    public count(): number {
        return this.call(LuaGcWhat.Count) * 1024 + this.call(LuaGcWhat.CountB)
    }

    /**
     * Lua only reports the mode while switching, so this switches to incremental and back when
     * that was not what ran. Not free on a generational state, where the switch back runs a minor
     * collection.
     */
    public getMode(): LuaGcMode {
        const previous = this.setMode('incremental')
        if (previous === 'generational') {
            this.setMode('generational')
        }
        return previous
    }

    /**
     * Lua defaults to incremental. Generational trades throughput on programs that keep most of
     * what they allocate for lower pause times when most objects die young.
     * @returns the mode that was running before.
     */
    public setMode(mode: LuaGcMode): LuaGcMode {
        if (mode !== 'incremental' && mode !== 'generational') {
            throw new TypeError(`unknown garbage collector mode '${mode}', expected incremental or generational`)
        }
        const previous = this.call(mode === 'generational' ? LuaGcWhat.Gen : LuaGcWhat.Inc)
        return previous === LuaGcWhat.Gen ? 'generational' : 'incremental'
    }

    /**
     * Reads a collector tunable, and sets it when `value` is given. Lua stores these with about two
     * significant digits of precision, so a value read back can differ from the one set.
     * @returns the value it had before the call.
     */
    public param(name: LuaGcParam, value?: number): number {
        const index = LUA_GC_PARAMS[name]
        if (index === undefined) {
            throw new TypeError(`unknown garbage collector parameter '${name}', expected one of: ${Object.keys(LUA_GC_PARAMS).join(', ')}`)
        }
        if (value !== undefined) {
            assertNonNegativeInteger(name, value)
        }
        // -1 tells lua_gc to leave the parameter alone.
        return this.call(LuaGcWhat.Param, index, value ?? -1)
    }

    private call(what: LuaGcWhat, a = 0, b = 0): number {
        this.state.assertNotClosed()
        const result = this.state.module.lua_gc(this.state.address, what, a, b)
        // lua_gc refuses every option while a collection is in progress, which from JS can only
        // mean this was reached from a __gc or __close handler run by the collector itself.
        if (result < 0) {
            throw new Error('the garbage collector cannot be controlled from inside a finalizer')
        }
        return result
    }
}

function assertNonNegativeInteger(name: string, value: number): void {
    if (!(Number.isInteger(value) && value >= 0)) {
        throw new RangeError(`garbage collector ${name} must be a non-negative integer, got ${value}`)
    }
}
