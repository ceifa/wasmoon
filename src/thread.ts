import { Decoration, type DecorationOptions, type LuaMetatable } from './decoration'
import type LuaModule from './module'
import MultiReturn from './multireturn'
import type LuaTypeExtension from './type-extension'
import {
    defaultWarnHandler,
    LUA_MULTRET,
    LUA_REGISTRYINDEX,
    type LuaAddress,
    LuaError,
    LuaEventMasks,
    type LuaGetCache,
    LuaInstructionLimitError,
    LuaInterruptError,
    type LuaLoadOptions,
    type LuaPushCache,
    type LuaResumeResult,
    LuaReturn,
    type LuaRunOptions,
    type LuaThreadLimits,
    LuaType,
    type LuaWarnHandler,
    PointerSize,
} from './types'
import { isEmscriptenUnwind, isPromise } from './utils'
import { awaitInterruptible, limitError, yieldToEventLoop } from './async'
import RawResult from './raw-result'

export interface OrderedExtension {
    // Bigger is more important
    priority: number
    extension: LuaTypeExtension<unknown>
}

// When the debug count hook is set, call it every X instructions.
const INSTRUCTION_HOOK_COUNT = 1000

const LUA_INTEGER_BITS = 64

const NO_RESTORE = (): void => undefined
const NO_OPTIONS: Readonly<DecorationOptions> = Object.freeze({})

export default class Thread {
    public readonly address: LuaAddress
    /** The raw bindings, shared by every state and thread on the same runtime. */
    public readonly module: LuaModule
    /** Set on the root state; threads created from it delegate here, as does {@link warn}. */
    public onWarn: LuaWarnHandler | undefined
    protected readonly typeExtensions: OrderedExtension[]
    protected readonly parent: Thread | undefined
    /**
     * The state this thread belongs to, or itself when it is the state. Resolved once here rather
     * than walked on demand: it is what {@link isClosed} and the shared slots below consult, and
     * those sit in front of the entry points the interop benchmarks measure.
     */
    protected readonly rootThread: Thread
    /**
     * The address of each registered extension's metatable, mapped to the extension's name.
     * Populated by `LuaState.registerTypeExtension` and shared with every thread on the same
     * state: those metatables are registry anchored for the state's whole life, so an address in
     * here can never be reused by anything else while the map exists.
     */
    protected readonly metatableNames: Map<LuaAddress, string>
    private closed = false
    private hookFunctionPointer: number | undefined
    private hookCount = INSTRUCTION_HOOK_COUNT
    private limits: LuaThreadLimits = {}
    private instructionsUsed = 0
    /**
     * The error the debug hook unwound the current run with. See {@link LuaModule.interruptToken}
     * for why it is held here rather than pushed into Lua. Kept on the root thread, because the
     * hook fires with whichever thread Lua is running -- a coroutine inherits it -- while the
     * {@link assertOk} that reports it is the one the run was started on.
     */
    private pendingInterrupt: LuaInterruptError | undefined

    public constructor(cmodule: LuaModule, typeExtensions: OrderedExtension[], address: number, parent?: Thread) {
        this.module = cmodule
        this.typeExtensions = typeExtensions
        this.address = address
        this.parent = parent
        this.rootThread = parent ?? this
        this.metatableNames = parent ? parent.metatableNames : new Map()
    }

    public newThread(): Thread {
        this.assertNotClosed()
        const address = this.module.lua_newthread(this.address)
        if (!address) {
            throw new Error('lua_newthread returned a null pointer')
        }
        return new Thread(this.module, this.typeExtensions, address, this.rootThread)
    }

    /**
     * A new thread anchored in the registry instead of left on this thread's stack. The reference
     * is what keeps it alive: `luaL_unref` it to let the thread go, or keep it forever for a
     * thread meant to live as long as the state.
     */
    public newAnchoredThread(): { thread: Thread; reference: number } {
        const thread = this.newThread()
        // Taken on this thread's stack, where newThread left the new one.
        const reference = this.module.luaL_ref(this.address, LUA_REGISTRYINDEX)
        return { thread, reference }
    }

    public resetThread(): void {
        this.assertNotClosed()
        this.assertOk(this.module.lua_resetthread(this.address))
    }

    /** @param options.mode defaults to `'t'`. See {@link LuaLoadOptions.mode}. */
    public loadString(luaCode: string, options?: LuaLoadOptions): void {
        this.assertNotClosed()
        // Lua copies the chunk while loading, so the shared buffer can be handed straight to it
        // rather than encoded into an allocation of its own.
        this.assertOk(
            this.module.withCString(luaCode, (pointer, size) =>
                this.module.luaL_loadbufferx(this.address, pointer, size, options?.name ?? pointer, options?.mode ?? 't'),
            ),
        )
    }

    /** @param options.mode defaults to `'t'`. See {@link LuaLoadOptions.mode}. */
    public loadFile(filename: string, options?: LuaLoadOptions): void {
        this.assertNotClosed()
        this.assertOk(this.module.luaL_loadfilex(this.address, filename, options?.mode ?? 't'))
    }

    /**
     * Unwinds the currently running coroutine at `L` with a limit error, the same way the debug
     * hook does: the token identifies it in {@link assertOk}, so a `pcall` in the script cannot
     * swallow it. Used by the JSPI await hook to abandon a run parked past its deadline or on an
     * aborted signal. Returns what `lua_error` returns, which never actually returns.
     */
    public interruptWith(error: LuaInterruptError): number {
        this.rootThread.pendingInterrupt = error
        this.module.lua_pushlightuserdata(this.address, this.module.interruptToken)
        return this.module.lua_error(this.address)
    }

    public resume(argCount = 0): LuaResumeResult {
        // Also covers the resumes `run` makes after an await, where the state can have been closed
        // by anything else that got to run in the meantime.
        this.assertNotClosed()
        this.rootThread.pendingInterrupt = undefined
        // The shared slot is safe for the same reason the one behind it is: C writes the count as it
        // returns and it is read straight after, with nothing interleaved. A nested resume has
        // finished with the slot by the time this one's lua_resume writes to it.
        const dataPointer = this.module.resultCountScratch
        this.module.writePointer(dataPointer, 0)
        const luaResult = this.module.lua_resume(this.address, null, argCount, dataPointer)
        return {
            result: luaResult,
            resultCount: this.module.readPointer(dataPointer),
        }
    }

    public getTop(): number {
        return this.module.lua_gettop(this.address)
    }

    public setTop(index: number): void {
        this.module.lua_settop(this.address, index)
    }

    public remove(index: number): void {
        return this.module.lua_remove(this.address, index)
    }

    public setField(index: number, name: string, value: unknown): void {
        index = this.absIndex(index)
        this.pushValue(value)
        this.module.lua_setfield(this.address, index, name)
    }

    public async run(argCount = 0, options?: LuaRunOptions): Promise<MultiReturn> {
        this.assertNotClosed()
        const restore = this.applyRunOptions(options)
        try {
            if (this.module.useJspi) {
                return await this.runJspi(argCount, options)
            }
            return await this.runYielding(argCount, options)
        } finally {
            restore()
        }
    }

    /**
     * The engine-agnostic run loop. An `:await()` parks by yielding the promise, which is awaited
     * here and can be interrupted by the deadline or abort signal. Any other yield is a host yield:
     * its values go to `options.onYield`, and its return decides what the resume hands back.
     */
    private async runYielding(argCount: number, options?: LuaRunOptions): Promise<MultiReturn> {
        return this.continueYielding(this.resumeYielding(argCount), options)
    }

    /**
     * Runs `fn` with suspension forced off, so an `:await()` it reaches parks by yielding the
     * coroutine rather than suspending the wasm stack. Every non-promising driver goes through here
     * -- the yielding resume, and the synchronous `lua_pcallk` entry points -- so `stackCanSuspend`
     * means exactly "the innermost driver is a promising resume", which is what the await guard reads.
     */
    private withSuspensionDisabled<T>(fn: () => T): T {
        const previousCanSuspend = this.module.stackCanSuspend
        this.module.stackCanSuspend = false
        try {
            return fn()
        } finally {
            this.module.stackCanSuspend = previousCanSuspend
        }
    }

    /** A resume of the yielding loop, forced onto the yield path rather than a wasm suspension. */
    public resumeYielding(argCount = 0): LuaResumeResult {
        return this.withSuspensionDisabled(() => this.resume(argCount))
    }

    /**
     * Throws the pending limit error if this parked thread has exceeded its deadline or been
     * aborted, dropping the yielded values first. The hook only fires while Lua runs, so a parked
     * thread is checked here instead.
     */
    private throwIfLimitReached(resumeResult: LuaResumeResult): void {
        const error = this.checkYieldLimits()
        if (error) {
            if (resumeResult.resultCount > 0) {
                this.pop(resumeResult.resultCount)
            }
            throw error
        }
    }

    /**
     * Handles a host yield -- a top level `coroutine.yield` that is not an await -- by handing its
     * values to `onYield` and returning how many values the resume passes back, or dropping them
     * when there is no handler.
     */
    private async handleHostYield(resumeResult: LuaResumeResult, options?: LuaRunOptions): Promise<number> {
        if (options?.onYield) {
            const values = this.getStackValues(this.getTop() - resumeResult.resultCount)
            this.assertNotClosed()
            return this.pushReturnValues(await options.onYield(values))
        }
        if (resumeResult.resultCount > 0) {
            this.pop(resumeResult.resultCount)
        }
        return 0
    }

    /** The yielding run loop, continued from an already obtained resume result. */
    public async continueYielding(first: LuaResumeResult, options?: LuaRunOptions): Promise<MultiReturn> {
        let resumeResult: LuaResumeResult = first
        while (resumeResult.result === LuaReturn.Yield) {
            this.throwIfLimitReached(resumeResult)

            // An unrepresentable yielded value is not necessarily an error: only an await needs to
            // read it, and a host yield of one is handed to onYield as it lies on the stack.
            let awaited: PromiseLike<unknown> | undefined
            if (resumeResult.resultCount > 0) {
                let lastValue: unknown
                try {
                    lastValue = this.getValue(-1)
                } catch {
                    lastValue = undefined
                }
                if (isPromise(lastValue)) {
                    awaited = lastValue
                }
            }

            let nextArgCount = 0
            if (awaited) {
                this.pop(resumeResult.resultCount)
                const { deadline, signal } = this.getLimits()
                await awaitInterruptible(awaited, signal, deadline)
            } else {
                nextArgCount = await this.handleHostYield(resumeResult, options)
                if (!options?.onYield) {
                    // Skip a tick so promises, timers and the like get a turn before Lua resumes.
                    await yieldToEventLoop()
                }
            }

            // The wait itself can outlast the deadline, and resuming would hand Lua another full
            // slice before the hook noticed.
            const waitError = this.checkYieldLimits()
            if (waitError) {
                throw waitError
            }

            resumeResult = this.resumeYielding(nextArgCount)
        }

        this.assertOk(resumeResult.result)
        return this.getStackValues()
    }

    /**
     * Runs under JSPI, so an `:await()` suspends the wasm stack instead of yielding a promise. Only
     * a host `coroutine.yield` returns control here, and it is handled the same as in the yielding
     * engine; the awaits resolve inside the promising resume without the loop seeing them.
     */
    private async runJspi(argCount: number, options?: LuaRunOptions): Promise<MultiReturn> {
        const module = this.module
        const nresPointer = module.emscripten._malloc(PointerSize)
        if (!nresPointer) {
            throw new Error('failed to allocate the JSPI result count slot')
        }
        // A promising resume parked on an await cannot be interrupted from outside, and closing the
        // state frees the stack it would resume into. This rejects the run instead; the await hook,
        // seeing the state closed, stays suspended rather than resuming into freed memory.
        const rootState = this.rootThread as unknown as { onClose(listener: () => void): () => void }
        let onClosed: () => void = NO_RESTORE
        const closed = new Promise<never>((_resolve, reject) => {
            onClosed = rootState.onClose(() => reject(new Error('the Lua state is closed')))
        })
        closed.catch(NO_RESTORE)
        try {
            let resumeResult = await Promise.race([this.resumeJspi(argCount, nresPointer), closed])
            while (resumeResult.result === LuaReturn.Yield) {
                this.throwIfLimitReached(resumeResult)
                const nextArgCount = await this.handleHostYield(resumeResult, options)
                resumeResult = await Promise.race([this.resumeJspi(nextArgCount, nresPointer), closed])
            }
            this.assertOk(resumeResult.result)
            // A parked run interrupted by its deadline or signal raises the interrupt into Lua, so a
            // pcall in the script could swallow it and let the run finish. As with the debug hook,
            // the interrupt still ends the run rather than being catchable from Lua.
            const interrupt = this.rootThread.pendingInterrupt
            if (interrupt) {
                this.rootThread.pendingInterrupt = undefined
                throw interrupt
            }
            return this.getStackValues()
        } finally {
            onClosed()
            module.emscripten._free(nresPointer)
        }
    }

    /**
     * One promising `lua_resume`. The promise it returns resolves only once the resume runs to a
     * host yield, a return or an error -- an `:await()` in between suspends and resumes the wasm
     * stack invisibly. The stack pointer is put back after the synchronous portion so a sync call
     * made while this run is parked reuses the C stack rather than growing past it.
     */
    private async resumeJspi(argCount: number, nresPointer: number): Promise<LuaResumeResult> {
        this.assertNotClosed()
        this.rootThread.pendingInterrupt = undefined
        const module = this.module
        const previousCanSuspend = module.stackCanSuspend
        const previousDeadline = module.activeRunDeadline
        const previousSignal = module.activeRunSignal
        module.stackCanSuspend = true
        const { deadline, signal } = this.getLimits()
        module.activeRunDeadline = deadline
        module.activeRunSignal = signal
        const entryStackPointer = module.stackSave()
        module.writePointer(nresPointer, 0)
        try {
            const pending = module.promisingResume()(this.address, null, argCount, nresPointer)
            module.stackRestore(entryStackPointer)
            const result: LuaReturn = await pending
            return { result, resultCount: module.readPointer(nresPointer) }
        } finally {
            module.stackCanSuspend = previousCanSuspend
            module.activeRunDeadline = previousDeadline
            module.activeRunSignal = previousSignal
            module.stackRestore(entryStackPointer)
        }
    }

    /**
     * Pushes a JS value onto the stack as Lua results and returns how many: nothing for `undefined`,
     * `count` for a {@link RawResult}, one per element for a {@link MultiReturn}, else the single
     * value. Shared by the run loops and the JS function wrapper.
     */
    public pushReturnValues(value: unknown): number {
        if (value === undefined) {
            return 0
        }
        if (value instanceof RawResult) {
            return value.count
        }
        if (value instanceof MultiReturn) {
            for (const item of value) {
                this.pushValue(item)
            }
            return value.length
        }
        this.pushValue(value)
        return 1
    }

    public runSync(argCount = 0, options?: LuaRunOptions): MultiReturn {
        this.assertNotClosed()
        this.rootThread.pendingInterrupt = undefined
        const restore = this.applyRunOptions(options)
        try {
            const base = this.getTop() - argCount - 1 // The 1 is for the function to run
            // A synchronous call: an `:await()` reached through it must yield rather than suspend,
            // and then fail because a pcalled thread cannot yield.
            this.withSuspensionDisabled(() => this.assertOk(this.module.lua_pcallk(this.address, argCount, LUA_MULTRET, 0, 0, null)))
            return this.getStackValues(base)
        } finally {
            restore()
        }
    }

    public pop(count = 1): void {
        this.module.lua_pop(this.address, count)
    }

    public call(name: string, ...args: any[]): MultiReturn {
        this.assertNotClosed()
        this.rootThread.pendingInterrupt = undefined
        const type = this.module.lua_getglobal(this.address, name)
        if (type !== LuaType.Function) {
            throw new TypeError(`cannot call '${name}': expected a function, got ${LuaType[type]}`)
        }

        for (const arg of args) {
            this.pushValue(arg)
        }

        const base = this.getTop() - args.length - 1 // The 1 is for the function to run
        this.withSuspensionDisabled(() => this.assertOk(this.module.lua_pcallk(this.address, args.length, LUA_MULTRET, 0, 0, null)))
        return this.getStackValues(base)
    }

    public getStackValues(start = 0): MultiReturn {
        const returns = this.getTop() - start
        const returnValues = new MultiReturn(returns)

        for (let i = 0; i < returns; i++) {
            returnValues[i] = this.getValue(start + i + 1)
        }

        return returnValues
    }

    public stateToThread(L: LuaAddress): Thread {
        if (L === this.address) {
            return this
        }
        return L === this.parent?.address ? this.parent : new Thread(this.module, this.typeExtensions, L, this.rootThread)
    }

    public pushValue(rawValue: unknown, cache?: LuaPushCache): void {
        // Only the type extensions take a decoration, so pushing a plain primitive never has to
        // allocate one. The default branch below synthesises one for the values that do need it.
        const decoration = rawValue instanceof Decoration ? rawValue : undefined
        const target = decoration ? decoration.target : rawValue

        if (target instanceof Thread) {
            this.module.lua_pushthread(target.address)
            if (target.address !== this.address) {
                this.module.lua_xmove(target.address, this.address, 1)
            }
            return
        }

        // Handle primitive types
        switch (typeof target) {
            case 'undefined':
                this.module.lua_pushnil(this.address)
                break
            case 'number':
                // Only integers JS can represent exactly become Lua integers. Values like 1e300
                // are integral but far outside int64, and would wrap silently if pushed as one.
                if (Number.isSafeInteger(target)) {
                    this.module.lua_pushinteger(this.address, target)
                } else {
                    this.module.lua_pushnumber(this.address, target)
                }
                break
            case 'bigint':
                if (BigInt.asIntN(LUA_INTEGER_BITS, target) !== target) {
                    throw new RangeError(`bigint ${target} does not fit in a 64 bit Lua integer`)
                }
                this.module.lua_pushinteger(this.address, target)
                break
            case 'string':
                this.module.lua_pushstring(this.address, target)
                break
            case 'boolean':
                this.module.lua_pushboolean(this.address, target ? 1 : 0)
                break
            default: {
                // A type extension can be supplied by the caller, so unlike the pushes above it is
                // not guaranteed to leave exactly one value behind. That is worth the two
                // lua_gettop calls here, and not worth them on every primitive push.
                const startTop = this.getTop()
                if (this.pushWithExtension(decoration ?? new Decoration(target, NO_OPTIONS), cache)) {
                    const endTop = this.getTop()
                    if (endTop !== startTop + 1) {
                        throw new Error(`pushValue expected stack size ${startTop + 1}, got ${endTop}`)
                    }
                } else if (target === null) {
                    this.module.lua_pushnil(this.address)
                } else {
                    throw new Error(`The type '${typeof target}' is not supported by Lua`)
                }
                break
            }
        }

        // A synthesised decoration always has empty options, so this only ever acts on one the
        // caller supplied.
        const metatable = decoration?.options.metatable
        if (metatable) {
            this.setMetatable(-1, metatable)
        }
    }

    public setMetatable(index: number, metatable: LuaMetatable): void {
        index = this.absIndex(index)

        if (this.module.lua_getmetatable(this.address, index)) {
            this.pop(1)
            const name = this.getMetatableName(index)
            throw new Error(`data already has associated metatable: ${name || 'unknown name'}`)
        }

        this.pushValue(metatable)
        this.module.lua_setmetatable(this.address, index)
    }

    public getMetatableName(index: number): string | undefined {
        // Resolving __name on every table and userdata read is most of what getValue spends on its
        // dispatch, and it is nearly always one of the extension metatables that registration
        // already recorded in metatableNames -- so the common case is these three raw calls and a
        // map hit, with no string crossing the boundary in either direction.
        if (!this.module.lua_getmetatable(this.address, index)) {
            return undefined
        }
        const pointer = this.module.lua_topointer(this.address, -1)

        let name = this.metatableNames.get(pointer)
        if (name !== undefined) {
            this.pop(1)
            return name
        }

        // Anything else reads __name off the metatable that is still on the stack.
        if (this.module.lua_getfield(this.address, -1, '__name') === LuaType.String) {
            name = this.module.lua_tolstring(this.address, -1, null)
        }
        this.pop(2)
        return name
    }

    public getValue(index: number, inputType?: LuaType, cache?: LuaGetCache): any {
        const type: LuaType = inputType ?? this.module.lua_type(this.address, index)

        switch (type) {
            case LuaType.None:
                return undefined
            case LuaType.Nil:
                return null
            case LuaType.Number: {
                const value = this.module.lua_tonumberx(this.address, index, null)
                // Only outside the safe range can the integer subtype change the result, and
                // checking that first keeps the common case to a single wasm call.
                if (Number.isSafeInteger(value) || !this.module.lua_isinteger(this.address, index)) {
                    return value
                }
                return this.module.lua_tointegerx(this.address, index, null)
            }
            case LuaType.String:
                return this.module.lua_tolstring(this.address, index, null)
            case LuaType.Boolean:
                return Boolean(this.module.lua_toboolean(this.address, index))
            case LuaType.Thread:
                return this.stateToThread(this.module.lua_tothread(this.address, index))
            default: {
                index = this.absIndex(index)

                let metatableName: string | undefined
                if (type === LuaType.Table || type === LuaType.Userdata) {
                    metatableName = this.getMetatableName(index)
                }

                const extensions = this.typeExtensions
                for (let i = 0; i < extensions.length; i++) {
                    const extension = extensions[i].extension
                    if (extension.isType(this, index, type, metatableName)) {
                        return extension.getValue(this, index, cache)
                    }
                }

                // Handing back an opaque Pointer hid the failure until the value was used, and
                // it could not be pushed back into Lua anyway.
                const typeName = this.module.lua_typename(this.address, type)
                const withMetatable = metatableName ? ` with metatable '${metatableName}'` : ''
                throw new TypeError(
                    `the Lua type '${typeName}'${withMetatable} has no JS representation; register a type ` +
                        `extension to handle it, or read the address with getPointer`,
                )
            }
        }
    }

    public close(): void {
        if (this.isClosed()) {
            return
        }

        if (this.hookFunctionPointer) {
            this.module.removeFunction(this.hookFunctionPointer)
            this.hookFunctionPointer = undefined
        }

        this.closed = true
    }

    public [Symbol.dispose](): void {
        this.close()
    }

    /**
     * Installs the deadline, instruction budget and abort signal enforced while this thread runs.
     * They share a single debug hook, because Lua only allows one hook per thread.
     */
    public setLimits(limits: LuaThreadLimits | undefined): void {
        this.assertNotClosed()
        this.limits = { ...limits }
        this.instructionsUsed = 0
        this.applyHook()
    }

    public getLimits(): LuaThreadLimits {
        return { ...this.limits }
    }

    /**
     * Shorthand for the deadline in {@link setLimits}. The argument is an absolute timestamp as
     * returned by `Date.now()`, not a duration — pass `Date.now() + ms`, or undefined to disable.
     * `LuaRunOptions.timeout` is the per-run equivalent that does take a duration.
     */
    public setDeadline(deadline: number | undefined): void {
        this.assertNotClosed()
        this.limits.deadline = deadline && deadline > 0 ? deadline : undefined
        this.applyHook()
    }

    public getDeadline(): number | undefined {
        return this.limits.deadline
    }

    /**
     * Diagnostics the library would otherwise have written straight to the console. Resolved on
     * every call rather than snapshotted, so clearing a state's handler falls back to the
     * runtime's rather than straight to the console.
     */
    public warn(message: string, cause?: unknown): void {
        ;(this.rootThread.onWarn ?? this.module.onWarn ?? defaultWarnHandler)(message, cause)
    }

    /** For identity checks on values JS cannot represent. */
    public getPointer(index: number): LuaAddress {
        return this.module.lua_topointer(this.address, index)
    }

    public isClosed(): boolean {
        // A thread's parent is always the state, so this is the whole chain rather than one step of
        // it, and the guard in front of the benchmarked entry points is three field reads.
        return !this.address || this.closed || this.rootThread.closed
    }

    /**
     * Guards the calls that begin a Lua operation. `lua_close` frees the `lua_State` on the wasm
     * heap, so without this one made afterwards reads and writes memory that has been handed back
     * to the allocator: it might trap, might return a plausible value, or might corrupt whatever
     * now owns those bytes.
     *
     * The rule is one check per operation, none per stack value: the primitives `getTop`, `setTop`,
     * `pop`, `remove`, `pushValue`, `getValue` and the readers around them stay unguarded so an
     * extension pays nothing for them, and everything that puts them to work is guarded here. A new
     * method belongs on one side or the other of that line.
     */
    public assertNotClosed(): void {
        if (this.isClosed()) {
            throw new Error('the Lua state is closed')
        }
    }

    public indexToString(index: number): string {
        const str = this.module.luaL_tolstring(this.address, index, null)
        // Pops the string pushed by luaL_tolstring
        this.pop()
        return str
    }

    /**
     * Values holding binary data (`string.dump`, `string.pack`, ciphertext, ...) cannot survive a
     * round trip through a JS string, so use this and {@link pushStringBytes} for those instead
     * of getValue/pushValue.
     * @returns the bytes, or undefined if the value is neither a string nor a number.
     */
    public getStringBytes(index: number): Uint8Array | undefined {
        return this.module.lua_tobytes(this.address, index)
    }

    public pushStringBytes(bytes: Uint8Array): void {
        this.module.lua_pushbytes(this.address, bytes)
    }

    public dumpStack(log = console.log): void {
        const top = this.getTop()

        for (let i = 1; i <= top; i++) {
            const type = this.module.lua_type(this.address, i)
            const typename = this.module.lua_typename(this.address, type)
            const pointer = this.getPointer(i)
            const name = this.indexToString(i)
            let value: unknown
            try {
                value = this.getValue(i, type)
            } catch (err) {
                // A debugging aid should survive one unrepresentable slot.
                value = `<${(err as Error).message}>`
            }

            log(i, typename, pointer, name, value)
        }
    }

    public assertOk(result: LuaReturn): void {
        if (result === LuaReturn.Ok || result === LuaReturn.Yield) {
            return
        }

        const stackTop = this.getTop()

        const interrupt = this.takePendingInterrupt(stackTop)
        if (interrupt) {
            throw interrupt
        }

        // This is the default message if there's nothing on the stack.
        let luaMessage = `Lua Error(${LuaReturn[result]}/${result})`
        let luaValue: unknown

        if (stackTop > 0) {
            if (result === LuaReturn.ErrorMem) {
                // If there's no memory just do a normal to string.
                luaMessage = this.module.lua_tolstring(this.address, -1, null)
            } else {
                try {
                    luaValue = this.getValue(-1)
                } catch {
                    // An unrepresentable error value must not replace the error being reported.
                    luaValue = undefined
                }

                // Calls __tostring if it exists and pushes onto the stack.
                luaMessage = this.indexToString(-1)
            }
        }

        // Not the hook's interrupts, which takePendingInterrupt above has already claimed: this is a
        // JS function that threw one itself, marshalled back by reference through the extension that
        // pushed it. Reported as thrown rather than wrapped, the same as one the hook raised.
        if (luaValue instanceof LuaInterruptError) {
            throw luaValue
        }

        let traceback: string | undefined
        if (result !== LuaReturn.ErrorMem) {
            try {
                this.module.luaL_traceback(this.address, this.address, null, 1)
                const text = this.module.lua_tolstring(this.address, -1, null)
                if (text.trim() !== 'stack traceback:') {
                    traceback = text
                }
                this.pop(1) // pop stack trace.
            } catch (err) {
                if (isEmscriptenUnwind(err)) {
                    throw err
                }
                this.warn('Failed to generate stack trace', err)
            }
        }

        throw new LuaError(result, luaMessage, { traceback, luaValue })
    }

    /**
     * The interrupt the hook unwound the run with, claimed only when the error being reported is
     * the token it pushed. A script that pcalled the interrupt away leaves the slot set with the
     * token nowhere on the stack, so whatever error did surface is still reported as itself.
     */
    private takePendingInterrupt(stackTop: number): LuaInterruptError | undefined {
        const root = this.rootThread
        if (root.pendingInterrupt === undefined || stackTop === 0) {
            return undefined
        }
        // The token is a heap address the module never hands to Lua, so nothing else can be at it.
        if (this.getPointer(-1) !== this.module.interruptToken) {
            return undefined
        }

        const interrupt = root.pendingInterrupt
        root.pendingInterrupt = undefined
        return interrupt
    }

    private applyRunOptions(options: LuaRunOptions | undefined): () => void {
        const overrides =
            options !== undefined &&
            (options.timeout !== undefined || options.maxInstructions !== undefined || options.signal !== undefined)

        if (!overrides) {
            return NO_RESTORE
        }

        const previousLimits = this.limits
        const previousUsed = this.instructionsUsed

        this.setLimits({
            deadline: options.timeout !== undefined ? Date.now() + options.timeout : previousLimits.deadline,
            maxInstructions: options.maxInstructions ?? previousLimits.maxInstructions,
            signal: options.signal ?? previousLimits.signal,
        })

        return () => {
            this.limits = previousLimits
            this.instructionsUsed = previousUsed
            this.applyHook()
        }
    }

    private applyHook(): void {
        // The restore that `applyRunOptions` hands back runs in a finally, so it reaches here after
        // a state closed midway through its own run. Returning rather than throwing, because that
        // finally must not replace whatever error is already on its way out.
        if (this.isClosed()) {
            return
        }

        const { deadline, maxInstructions, signal } = this.limits
        if (deadline === undefined && maxInstructions === undefined && signal === undefined) {
            this.module.lua_sethook(this.address, null, 0, 0)
            return
        }

        // A budget smaller than the default period would only ever be noticed late.
        this.hookCount =
            maxInstructions !== undefined ? Math.max(1, Math.min(INSTRUCTION_HOOK_COUNT, maxInstructions)) : INSTRUCTION_HOOK_COUNT

        if (!this.hookFunctionPointer) {
            this.hookFunctionPointer = this.module.addFunction((hookL: LuaAddress): void => {
                // Reads this.limits rather than closing over them, so a hook allocated for an
                // earlier configuration still honours the current one.
                const error = this.checkHookLimits(hookL)
                if (error) {
                    this.rootThread.pendingInterrupt = error
                    this.module.lua_pushlightuserdata(hookL, this.module.interruptToken)
                    this.module.lua_error(hookL)
                }
            }, 'vii')
        }

        this.module.lua_sethook(this.address, this.hookFunctionPointer, LuaEventMasks.Count, this.hookCount)
    }

    private checkHookLimits(hookL: LuaAddress): LuaInterruptError | undefined {
        const { maxInstructions } = this.limits
        if (maxInstructions !== undefined) {
            this.instructionsUsed += this.hookCount
            const remaining = maxInstructions - this.instructionsUsed
            if (remaining <= 0) {
                return new LuaInstructionLimitError(`thread exceeded its budget of ${maxInstructions} instructions`)
            }
            if (remaining < this.hookCount) {
                this.hookCount = remaining
                this.module.lua_sethook(hookL, this.hookFunctionPointer ?? null, LuaEventMasks.Count, remaining)
            }
        }
        return this.checkYieldLimits()
    }

    private checkYieldLimits(): LuaInterruptError | undefined {
        return limitError(this.limits.signal, this.limits.deadline)
    }

    /**
     * `lua_absindex` is the identity for an index that is already absolute, so the common case
     * skips the call into wasm.
     */
    private absIndex(index: number): number {
        return index > 0 ? index : this.module.lua_absindex(this.address, index)
    }

    /** Offers the value to each extension by descending priority. False if none claimed it. */
    private pushWithExtension(decoration: Decoration<unknown>, cache: LuaPushCache | undefined): boolean {
        const extensions = this.typeExtensions
        for (let i = 0; i < extensions.length; i++) {
            if (extensions[i].extension.pushValue(this, decoration, cache)) {
                return true
            }
        }
        return false
    }
}
