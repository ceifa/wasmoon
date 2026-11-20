import { copy, LuaMarshalled } from './marshal'
import type Marshaller from './marshaller'
import type LuaModule from './module'
import MultiReturn from './multireturn'
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
    type LuaLimits,
    type LuaLoadOptions,
    type LuaPushCache,
    type LuaResumeResult,
    LuaReturn,
    type LuaRunOptions,
    LuaType,
    type LuaWarnHandler,
    PointerSize,
} from './types'
import { isEmscriptenUnwind } from './utils'
import { limitError, settleOrInterrupt, yieldToEventLoop } from './async'

/**
 * What the debug hook enforces while a run is on a thread: a run's {@link LuaLimits} once it has
 * started, with the timeout turned into the moment it runs out.
 */
export interface ActiveLimits {
    /** Absolute timestamp, as returned by `Date.now()`. */
    deadline?: number | undefined
    maxInstructions?: number | undefined
    signal?: AbortSignal | undefined
}

// When the debug count hook is set, call it every X instructions.
const INSTRUCTION_HOOK_COUNT = 1000

const LUA_INTEGER_BITS = 64

const NO_RESTORE = (): void => undefined
/**
 * The limits of a thread no run is on, shared because a JS callback made from a coroutine gets a
 * thread wrapper of its own each time. Frozen, so a write to it fails loudly.
 */
const NO_LIMITS: Readonly<ActiveLimits> = Object.freeze({})
const NO_DEFAULT_LIMITS: Readonly<LuaLimits> = Object.freeze({})

export default class Thread {
    public readonly address: LuaAddress
    /** The raw bindings, shared by every state and thread on the same runtime. */
    public readonly module: LuaModule
    /** Set on the root state; threads created from it delegate here, as does {@link warn}. */
    public onWarn: LuaWarnHandler | undefined
    /** How values cross between JS and Lua, shared by every thread on the same state. */
    public readonly marshaller: Marshaller
    protected readonly parent: Thread | undefined
    /**
     * The state this thread belongs to, or itself when it is the state. Resolved once here rather
     * than walked on demand: it is what {@link isClosed} and the shared slots below consult, and
     * those sit in front of the entry points the interop benchmarks measure.
     */
    protected readonly rootThread: Thread
    /**
     * The limits a run starts under unless its own options say otherwise, as `state.limits`. Held
     * by the state and read from there, so it means nothing on any other thread.
     */
    protected defaultLimits: LuaLimits = NO_DEFAULT_LIMITS
    private closed = false
    private running = false
    private rejectRun: (() => void) | undefined
    private removeCloseListener: (() => void) | undefined
    private hookFunctionPointer: number | undefined
    private hookCount = INSTRUCTION_HOOK_COUNT
    /** The limits of the run this thread is on. Installed when it starts, removed when it ends. */
    private active: ActiveLimits = NO_LIMITS
    private instructionsUsed = 0
    /**
     * The error the debug hook unwound the current run with. See {@link LuaModule.interruptToken}
     * for why it is held here rather than pushed into Lua. The hook can fire on a Lua-created
     * coroutine, so it writes to the active driver, which also owns its limits and lifecycle.
     */
    private pendingInterrupt: LuaInterruptError | undefined
    /**
     * Whether Lua has stopped calling the debug hook on this thread. It disables the hook while
     * one runs and enables it again once that returns, which a hook that raises never does: a
     * `pcall` on the way out restores the flag, and without one the thread dies with its hook off.
     * Resetting such a thread brings it back to life without a hook that works, so it must not be
     * run again under a limit.
     */
    public hookLost = false
    private closeListeners: (() => void)[] | undefined

    /** The limits of the run this thread is driving, as an `:await()` reads them when it parks. */
    public get runLimits(): Readonly<ActiveLimits> {
        return this.active
    }

    public constructor(cmodule: LuaModule, marshaller: Marshaller, address: number, parent?: Thread) {
        this.module = cmodule
        this.marshaller = marshaller
        this.address = address
        this.parent = parent
        this.rootThread = parent ?? this
    }

    public newThread(): Thread {
        this.assertNotClosed()
        const address = this.module.lua_newthread(this.address)
        if (!address) {
            throw new Error('lua_newthread returned a null pointer')
        }
        return new Thread(this.module, this.marshaller, address, this.rootThread)
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
        const status = this.module.lua_resetthread(this.address)
        if (this.hookLost) {
            this.setTop(0)
            throw new Error(
                'a thread that a limit interrupted cannot be reset, because no limit could be enforced on it again: use a new one',
            )
        }
        this.assertOk(status)
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
     * Raises a limit error in the coroutine running at `L`: the debug hook's way of stopping a run,
     * and the await hook's for one parked past its deadline or on an aborted signal. The token is
     * what {@link assertOk} recognises the error by.
     */
    public interruptWith(error: LuaInterruptError, L = this.address): number {
        ;(this.module.activeRun ?? this).pendingInterrupt = error
        this.module.lua_pushlightuserdata(L, this.module.interruptToken)
        return this.module.lua_error(L)
    }

    public resume(argCount = 0): LuaResumeResult {
        this.assertNotClosed()
        this.pendingInterrupt = undefined
        const module = this.module
        // The shared slot is safe for the same reason the one behind it is: C writes the count as it
        // returns and it is read straight after, with nothing interleaved. A nested resume has
        // finished with the slot by the time this one's lua_resume writes to it.
        const dataPointer = module.resultCountScratch
        module.writePointer(dataPointer, 0)
        const previousRun = module.activeRun
        const previousCanSuspend = module.stackCanSuspend
        module.activeRun = this
        module.stackCanSuspend = false
        let result: LuaReturn
        try {
            result = module.lua_resume(this.address, null, argCount, dataPointer)
        } finally {
            module.activeRun = previousRun
            module.stackCanSuspend = previousCanSuspend
        }
        if (result <= LuaReturn.Yield) {
            // Alive, so whatever interrupt the hook raised was caught by a pcall on the way.
            this.hookLost = false
        }
        return { result, resultCount: module.readPointer(dataPointer) }
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

    /**
     * Runs the function and arguments on this thread's stack to completion, as a run that an
     * `:await()` can suspend. Under the state's limits, with `options` over them.
     */
    public async run(argCount = 0, options?: LuaRunOptions): Promise<MultiReturn> {
        this.startRun()
        let restore = NO_RESTORE
        try {
            restore = this.enterRun(options, false)
            return await this.watchRun(this.drive(argCount, options))
        } finally {
            this.finishRun()
            restore()
        }
    }

    private startRun(): void {
        this.assertNotClosed()
        if (this.running) {
            throw new Error('the Lua thread is already running')
        }
        this.running = true
    }

    /** One close listener and promise per asynchronous entry, rather than one race per resume. */
    private watchRun(pending: Promise<MultiReturn>): Promise<MultiReturn> {
        return new Promise((resolve, reject) => {
            this.rejectRun = () => reject(new Error('the Lua state is closed'))
            this.removeCloseListener = this.rootThread.onClose(this.rejectRun)
            pending.then(resolve, reject)
            if (this.isClosed()) {
                this.rejectRun()
            }
        })
    }

    private finishRun(): void {
        this.removeCloseListener?.()
        this.removeCloseListener = undefined
        this.rejectRun = undefined
        this.running = false
    }

    private dropResults(resumeResult: LuaResumeResult): void {
        if (resumeResult.resultCount > 0) {
            this.pop(resumeResult.resultCount)
        }
    }

    /**
     * Handles a host yield -- a top level `coroutine.yield`, which is never an await -- and returns
     * how many values the resume passes back. With a handler those are whatever `onYield` answers
     * with; without one the yield is a request for the event loop to take a turn.
     */
    private async handleHostYield(resumeResult: LuaResumeResult, options?: LuaRunOptions): Promise<number> {
        if (!options?.onYield) {
            this.dropResults(resumeResult)
            await yieldToEventLoop()
            return 0
        }
        const values = this.getStackValues(this.getTop() - resumeResult.resultCount)
        this.dropResults(resumeResult)
        const outcome = await settleOrInterrupt(options.onYield(values), this.active.signal, this.active.deadline)
        this.assertNotClosed()
        this.assertLimits()
        if (outcome.status !== 'fulfilled') {
            throw outcome.error
        }
        const resultCount = this.pushReturnValues(outcome.value)
        // A handler that answers at once would otherwise never let a timer fire.
        const pause = this.module.scheduleAsync()
        if (pause) {
            await pause
        }
        return resultCount
    }

    /**
     * Drives the coroutine to completion. An `:await()` suspends the wasm stack inside the resume
     * and continues there once its promise settles, so the only thing that brings control back here
     * before the end is a host yield.
     */
    private async drive(argCount: number, options?: LuaRunOptions): Promise<MultiReturn> {
        const module = this.module
        // A slot of its own rather than the shared scratch one: a resume that suspended reports its
        // count long after it was entered, by when other runs have been through the shared slot.
        const nresPointer = module.emscripten._malloc(PointerSize)
        if (!nresPointer) {
            throw new Error('failed to allocate the result count slot of an async run')
        }
        try {
            let resumeResult = await this.resumeSuspendable(argCount, nresPointer)
            while (resumeResult.result === LuaReturn.Yield) {
                // The hook only fires while Lua runs, so a deadline that passed or a signal that
                // aborted while the coroutine was getting here is noticed now.
                const limit = this.limitReached()
                if (limit) {
                    this.dropResults(resumeResult)
                    throw limit
                }
                const nextArgCount = await this.handleHostYield(resumeResult, options)
                // The wait itself can outlast the deadline, and resuming would hand Lua another full
                // slice before the hook noticed.
                this.assertLimits()
                resumeResult = await this.resumeSuspendable(nextArgCount, nresPointer)
            }
            this.assertOk(resumeResult.result)
            // A parked run interrupted by its deadline or signal raises the interrupt into Lua, where
            // a pcall can catch it and let the script reach its end. The run still reports it.
            const interrupt = this.pendingInterrupt
            if (interrupt) {
                this.pendingInterrupt = undefined
                throw interrupt
            }
            return this.getStackValues()
        } finally {
            module.emscripten._free(nresPointer)
        }
    }

    /** One `lua_resume` that an `:await()` can suspend, up to a host yield, a return or an error. */
    private async resumeSuspendable(argCount: number, nresPointer: number): Promise<LuaResumeResult> {
        this.assertNotClosed()
        this.pendingInterrupt = undefined
        const module = this.module
        const previousCanSuspend = module.stackCanSuspend
        const previousRun = module.activeRun
        module.stackCanSuspend = module.jspiSupported
        module.activeRun = this
        const entryStackPointer = module.stackSave()
        module.writePointer(nresPointer, 0)
        let pending: Promise<LuaReturn> | LuaReturn
        try {
            pending = module.suspendableResume(this.address, null, argCount, nresPointer)
        } finally {
            // Restore the caller immediately, not when this suspended run eventually settles: a call
            // made while it is parked then reuses the C stack rather than growing past it.
            module.activeRun = previousRun
            module.stackCanSuspend = previousCanSuspend
            module.stackRestore(entryStackPointer)
        }
        try {
            const result = await pending
            this.assertNotClosed()
            if (result <= LuaReturn.Yield) {
                this.hookLost = false
            }
            return { result, resultCount: module.readPointer(nresPointer) }
        } finally {
            if (module.activeRun === this) {
                module.activeRun = undefined
                module.stackCanSuspend = false
            }
            // Everything past the await runs from an empty JS stack, where no C frame is live. Not
            // the entry pointer again: the caller it belonged to is long gone, and putting it back
            // would leave everything above it unusable for good.
            module.stackRestore(module.mainStackPointer)
        }
    }

    /**
     * Pushes a JS value onto the stack as Lua results and returns how many: nothing for `undefined`,
     * one per element for a {@link MultiReturn}, else the single value.
     * @param nilOnUndefined Preserve undefined as one Lua nil, as `:await()` requires.
     */
    public pushReturnValues(value: unknown, nilOnUndefined = false): number {
        if (value === undefined && !nilOnUndefined) {
            return 0
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

    /**
     * The synchronous counterpart of {@link run}, which nothing can suspend. Started from inside
     * another run it stays within that one's limits too.
     */
    public runSync(argCount = 0, options?: LuaRunOptions): MultiReturn {
        this.assertNotClosed()
        const restore = this.enterRun(options, true)
        try {
            const base = this.getTop() - argCount - 1 // The 1 is for the function to run
            this.pcall(argCount)
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
        const type = this.module.lua_getglobal(this.address, name)
        if (type !== LuaType.Function) {
            throw new TypeError(`cannot call '${name}': expected a function, got ${LuaType[type]}`)
        }

        for (const arg of args) {
            this.pushValue(arg)
        }

        const base = this.getTop() - args.length - 1 // The 1 is for the function to run
        const restore = this.enterRun(undefined, true)
        try {
            this.pcall(args.length)
            return this.getStackValues(base)
        } finally {
            restore()
        }
    }

    /** A synchronous call, which nothing can suspend: an `:await()` reached through it is an error. */
    private pcall(argCount: number): void {
        const module = this.module
        this.pendingInterrupt = undefined
        const previousRun = module.activeRun
        const previousCanSuspend = module.stackCanSuspend
        module.activeRun = this
        module.stackCanSuspend = false
        let result: LuaReturn
        try {
            result = module.lua_pcallk(this.address, argCount, LUA_MULTRET, 0, 0, null)
        } finally {
            module.activeRun = previousRun
            module.stackCanSuspend = previousCanSuspend
        }
        // lua_pcall puts the flag back itself, which lua_resume does not.
        this.hookLost = false
        this.assertOk(result)
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
        const active = this.module.activeRun
        if (active?.address === L) {
            return active
        }
        if (L === this.address) {
            return this
        }
        return L === this.parent?.address ? this.parent : new Thread(this.module, this.marshaller, L, this.rootThread)
    }

    /**
     * Pushes a JS value onto the stack as one Lua value. A primitive has one way to cross; anything
     * else crosses the way the state's {@link Marshaller} decides, which is where the order of
     * `copy`, `proxy`, `opaque`, defined types and classes is spelled out.
     */
    public pushValue(value: unknown, cache?: LuaPushCache): void {
        switch (typeof value) {
            case 'undefined':
                this.module.lua_pushnil(this.address)
                break
            case 'number':
                // Only integers JS can represent exactly become Lua integers. Values like 1e300
                // are integral but far outside int64, and would wrap silently if pushed as one.
                if (Number.isSafeInteger(value)) {
                    this.module.lua_pushinteger(this.address, value)
                } else {
                    this.module.lua_pushnumber(this.address, value)
                }
                break
            case 'bigint':
                if (BigInt.asIntN(LUA_INTEGER_BITS, value) !== value) {
                    throw new RangeError(`bigint ${value} does not fit in a 64 bit Lua integer`)
                }
                this.module.lua_pushinteger(this.address, value)
                break
            case 'string':
                this.module.lua_pushstring(this.address, value)
                break
            case 'boolean':
                this.module.lua_pushboolean(this.address, value ? 1 : 0)
                break
            default:
                if (value instanceof Thread) {
                    this.module.lua_pushthread(value.address)
                    if (value.address !== this.address) {
                        this.module.lua_xmove(value.address, this.address, 1)
                    }
                } else {
                    this.marshaller.push(this, value, cache)
                }
                break
        }
    }

    /**
     * Gives the Lua table at `index` a metatable, copied into a table of its own unless it is
     * wrapped to cross some other way.
     */
    public setMetatable(index: number, metatable: object): void {
        index = this.absIndex(index)

        // Lua has one metatable for all functions, all strings and so on: setting it through one
        // value would change every other, so only what owns its metatable can be given one.
        if (this.module.lua_type(this.address, index) !== LuaType.Table) {
            throw new TypeError('only a value copied into a Lua table can be given a metatable')
        }
        if (this.module.lua_getmetatable(this.address, index)) {
            this.pop(1)
            const name = this.getMetatableName(index)
            throw new Error(`data already has associated metatable: ${name || 'unknown name'}`)
        }

        this.pushValue(metatable instanceof LuaMarshalled ? metatable : copy(metatable))
        this.module.lua_setmetatable(this.address, index)
    }

    /** The name of the metatable of the value at `index`: its `__name`, or undefined without one. */
    public getMetatableName(index: number): string | undefined {
        if (!this.module.lua_getmetatable(this.address, index)) {
            return undefined
        }

        // One this state created is known by its address, with no string crossing the boundary.
        let name = this.marshaller.owners.get(this.module.lua_topointer(this.address, -1))?.name
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
                // Only a whole number outside the safe range can be an integer the double got
                // wrong, and checking that first keeps every other read to a single wasm call.
                if (Number.isSafeInteger(value) || !Number.isInteger(value) || !this.module.lua_isinteger(this.address, index)) {
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
            default:
                return this.marshaller.get(this, this.absIndex(index), type, cache)
        }
    }

    public close(): void {
        if (this.isClosed()) {
            return
        }

        this.closed = true
        if (this.hookFunctionPointer) {
            this.module.removeFunction(this.hookFunctionPointer)
            this.hookFunctionPointer = undefined
        }
        this.rejectRun?.()

        if (this === this.rootThread) {
            const listeners = this.closeListeners
            this.closeListeners = undefined
            if (listeners) {
                for (const listener of listeners) {
                    listener()
                }
            }
        }
    }

    /** Notified once when this state closes, so an owner can drop its reference. Returns a function that removes the listener. */
    public onClose(listener: () => void): () => void {
        const root = this.rootThread
        ;(root.closeListeners ??= []).push(listener)
        return () => {
            const index = root.closeListeners?.indexOf(listener) ?? -1
            if (index >= 0) {
                root.closeListeners!.splice(index, 1)
            }
        }
    }

    public [Symbol.dispose](): void {
        this.close()
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
        if (this.pendingInterrupt === undefined || stackTop === 0) {
            return undefined
        }
        // The token is a heap address the module never hands to Lua, so nothing else can be at it.
        if (this.getPointer(-1) !== this.module.interruptToken) {
            return undefined
        }

        const interrupt = this.pendingInterrupt
        this.pendingInterrupt = undefined
        return interrupt
    }

    /**
     * Puts this thread under the limits of a run that is about to start on it: the state's, with
     * `options` over them field by field, where `Infinity` lifts one the state set. Returns what
     * ends the run, which puts back whatever the thread was under before.
     *
     * A `nested` run is one started while another is on the JS stack -- a synchronous call back
     * into Lua from a function Lua called -- and it runs inside that one: it cannot outlast its
     * deadline, spends from its instruction budget, and is aborted by its signal. A run that goes
     * on after its caller returns, as every asynchronous one does, is on its own.
     *
     * The budget is shared to the hook's granularity and no finer: instructions are counted a
     * hook period at a time, so a nested run shorter than one period ends before any of it is
     * counted. The deadline has no such gap.
     */
    public enterRun(options: LuaLimits | undefined, nested: boolean): () => void {
        const outer = nested ? this.module.activeRun : undefined
        const limits = this.resolveLimits(options, outer)
        const previous = this.active
        // Nothing to install and nothing installed, which is every run of a state without limits.
        if (limits === undefined && previous === NO_LIMITS) {
            return NO_RESTORE
        }

        const previousUsed = this.instructionsUsed
        this.active = limits ?? NO_LIMITS
        this.instructionsUsed = 0
        this.applyHook()

        return () => {
            const used = this.instructionsUsed
            this.active = previous
            this.instructionsUsed = previousUsed
            // What the nested run executed counts against the run it was made from, or calling
            // back and forth would be a way around the budget.
            if (outer !== undefined) {
                outer.instructionsUsed += used
            }
            this.applyHook()
        }
    }

    private resolveLimits(options: LuaLimits | undefined, outer: Thread | undefined): ActiveLimits | undefined {
        const defaults = this.rootThread.defaultLimits
        const timeout = options?.timeout ?? defaults.timeout
        let maxInstructions = options?.maxInstructions ?? defaults.maxInstructions
        let signal = options?.signal ?? defaults.signal
        let deadline = timeout === undefined || timeout === Infinity ? undefined : Date.now() + timeout
        if (maxInstructions === Infinity) {
            maxInstructions = undefined
        }

        if (outer !== undefined && outer.active !== NO_LIMITS) {
            const enclosing = outer.active
            if (enclosing.deadline !== undefined && (deadline === undefined || enclosing.deadline < deadline)) {
                deadline = enclosing.deadline
            }
            if (enclosing.maxInstructions !== undefined) {
                const remaining = Math.max(0, enclosing.maxInstructions - outer.instructionsUsed)
                if (maxInstructions === undefined || remaining < maxInstructions) {
                    maxInstructions = remaining
                }
            }
            signal ??= enclosing.signal
        }

        if (deadline === undefined && maxInstructions === undefined && signal === undefined) {
            return undefined
        }
        return { deadline, maxInstructions, signal }
    }

    private applyHook(): void {
        // The restore that `enterRun` hands back runs in a finally, so it reaches here after
        // a state closed midway through its own run. Returning rather than throwing, because that
        // finally must not replace whatever error is already on its way out.
        if (this.isClosed()) {
            return
        }

        const { deadline, maxInstructions, signal } = this.active
        if (deadline === undefined && maxInstructions === undefined && signal === undefined) {
            this.module.lua_sethook(this.address, null, 0, 0)
            return
        }

        // A budget smaller than the default period would only ever be noticed late.
        this.hookCount =
            maxInstructions !== undefined ? Math.max(1, Math.min(INSTRUCTION_HOOK_COUNT, maxInstructions)) : INSTRUCTION_HOOK_COUNT

        if (!this.hookFunctionPointer) {
            this.hookFunctionPointer = this.module.addFunction((hookL: LuaAddress): void => {
                // Reads the active limits rather than closing over them, so a hook allocated for
                // an earlier run still honours the current one.
                const run = this.module.activeRun ?? this
                const error = run.checkHookLimits(hookL)
                if (error) {
                    if (hookL === run.address) {
                        run.hookLost = true
                    }
                    run.interruptWith(error, hookL)
                }
            }, 'vii')
        }

        this.module.lua_sethook(this.address, this.hookFunctionPointer, LuaEventMasks.Count, this.hookCount)
    }

    private checkHookLimits(hookL: LuaAddress): LuaInterruptError | undefined {
        const { maxInstructions } = this.active
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
        return this.limitReached()
    }

    private limitReached(): LuaInterruptError | undefined {
        return limitError(this.active.signal, this.active.deadline)
    }

    private assertLimits(): void {
        const error = this.limitReached()
        if (error) {
            throw error
        }
    }

    /**
     * `lua_absindex` is the identity for an index that is already absolute, so the common case
     * skips the call into wasm.
     */
    private absIndex(index: number): number {
        return index > 0 ? index : this.module.lua_absindex(this.address, index)
    }
}
