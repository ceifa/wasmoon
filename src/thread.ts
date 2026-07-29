import { Decoration, type LuaMetatable } from './decoration'
import type LuaModule from './module'
import MultiReturn from './multireturn'
import type LuaTypeExtension from './type-extension'
import {
    defaultWarnHandler,
    LUA_MULTRET,
    LuaAbortError,
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
    LuaTimeoutError,
    LuaType,
    type LuaWarnHandler,
} from './types'
import { isEmscriptenUnwind, isPromise, yieldToEventLoop } from './utils'

export interface OrderedExtension {
    // Bigger is more important
    priority: number
    extension: LuaTypeExtension<unknown>
}

// When the debug count hook is set, call it every X instructions.
const INSTRUCTION_HOOK_COUNT = 1000

const LUA_INTEGER_BITS = 64

// LUAI_MAXSHORTLEN. At or below it Lua interns the string, which is what lets getMetatableName treat
// an address as the identity of a name.
const LUA_MAX_SHORT_STRING = 40

const NO_RESTORE = (): void => undefined

export default class Thread {
    public readonly address: LuaAddress
    /** The raw bindings, shared by every state and thread on the same runtime. */
    public readonly module: LuaModule
    /** Set on the root state; threads created from it delegate here, as does {@link warn}. */
    public onWarn: LuaWarnHandler | undefined
    protected readonly typeExtensions: OrderedExtension[]
    protected readonly parent: Thread | undefined
    /**
     * Shared with every thread on the same state, and only ever holding names anchored by that
     * state, so it goes when the state does and nothing in it can outlive what it describes.
     */
    private readonly metatableNames: Map<LuaAddress, string>
    private closed = false
    private hookFunctionPointer: number | undefined
    private hookCount = INSTRUCTION_HOOK_COUNT
    private limits: LuaThreadLimits = {}
    private instructionsUsed = 0

    public constructor(cmodule: LuaModule, typeExtensions: OrderedExtension[], address: number, parent?: Thread) {
        this.module = cmodule
        this.typeExtensions = typeExtensions
        this.address = address
        this.parent = parent
        this.metatableNames = parent ? parent.metatableNames : new Map()
    }

    public newThread(): Thread {
        const address = this.module.lua_newthread(this.address)
        if (!address) {
            throw new Error('lua_newthread returned a null pointer')
        }
        return new Thread(this.module, this.typeExtensions, address, this.parent || this)
    }

    public resetThread(): void {
        this.assertOk(this.module.lua_resetthread(this.address))
    }

    /** @param options.mode defaults to `'t'`. See {@link LuaLoadOptions.mode}. */
    public loadString(luaCode: string, options?: LuaLoadOptions): void {
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
        this.assertOk(this.module.luaL_loadfilex(this.address, filename, options?.mode ?? 't'))
    }

    public resume(argCount = 0): LuaResumeResult {
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
        const restore = this.applyRunOptions(options)
        try {
            let resumeResult: LuaResumeResult = this.resume(argCount)
            while (resumeResult.result === LuaReturn.Yield) {
                // If it's completed there's no need to needlessly discard the output. The hook
                // only fires while Lua runs, so a parked thread is checked here instead.
                const limitError = this.checkYieldLimits()
                if (limitError) {
                    if (resumeResult.resultCount > 0) {
                        this.pop(resumeResult.resultCount)
                    }
                    throw limitError
                }
                if (resumeResult.resultCount > 0) {
                    const lastValue = this.getValue(-1)
                    this.pop(resumeResult.resultCount)

                    // If there's a result and it's a promise, then wait for it.
                    if (isPromise(lastValue)) {
                        await lastValue
                    } else {
                        // If it's a non-promise, then skip a tick to yield for promises, timers, etc.
                        await yieldToEventLoop()
                    }
                } else {
                    // If there's nothing to yield, then skip a tick to yield for promises, timers, etc.
                    await yieldToEventLoop()
                }

                // The wait itself can outlast the deadline, and resuming would hand Lua another
                // full slice before the hook noticed.
                const waitError = this.checkYieldLimits()
                if (waitError) {
                    throw waitError
                }

                resumeResult = this.resume(0)
            }

            this.assertOk(resumeResult.result)
            return this.getStackValues()
        } finally {
            restore()
        }
    }

    public runSync(argCount = 0, options?: LuaRunOptions): MultiReturn {
        const restore = this.applyRunOptions(options)
        try {
            const base = this.getTop() - argCount - 1 // The 1 is for the function to run
            this.assertOk(this.module.lua_pcallk(this.address, argCount, LUA_MULTRET, 0, 0, null))
            return this.getStackValues(base)
        } finally {
            restore()
        }
    }

    public pop(count = 1): void {
        this.module.lua_pop(this.address, count)
    }

    public call(name: string, ...args: any[]): MultiReturn {
        const type = this.module.lua_getglobal(this.address, name)
        if (type !== LuaType.Function) {
            throw new TypeError(`cannot call '${name}': expected a function, got ${LuaType[type]}`)
        }

        for (const arg of args) {
            this.pushValue(arg)
        }

        const base = this.getTop() - args.length - 1 // The 1 is for the function to run
        this.module.lua_callk(this.address, args.length, LUA_MULTRET, 0, null)
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
        return L === this.parent?.address ? this.parent : new Thread(this.module, this.typeExtensions, L, this.parent || this)
    }

    public pushValue(rawValue: unknown, cache?: LuaPushCache): void {
        // Only the type extensions take a decoration, so pushing a plain primitive never has to
        // allocate one. The default branch below synthesises one for the values that do need it.
        const decoration = rawValue instanceof Decoration ? rawValue : undefined
        const target = decoration ? decoration.target : rawValue

        if (target instanceof Thread) {
            const isMain = this.module.lua_pushthread(target.address) === 1
            if (!isMain) {
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
                    this.module.lua_pushinteger(this.address, BigInt(target))
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
                if (this.pushWithExtension(decoration ?? new Decoration(target, {}), cache)) {
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
        const metatableNameType = this.module.luaL_getmetafield(this.address, index, '__name')
        if (metatableNameType === LuaType.Nil) {
            return undefined
        }

        if (metatableNameType !== LuaType.String) {
            // Pop the metafield if it's not a string
            this.pop(1)
            return undefined
        }

        // Decoding this again on every table and userdata read is most of what getValue spends on
        // its dispatch, and it is nearly always one of a handful of extension names. Lua interns a
        // short string, so the address of the characters is the identity of the name: an extension's
        // own copy is anchored in the registry for as long as the state lives, which both keeps the
        // address from being reused and makes it the one every equal name resolves to.
        const pointer = this.module.lua_topointer(this.address, -1)
        let name = this.metatableNames.get(pointer)
        if (name === undefined) {
            name = this.module.lua_tolstring(this.address, -1, null)
            if (name.length <= LUA_MAX_SHORT_STRING && this.isExtensionName(name)) {
                this.metatableNames.set(pointer, name)
            }
        }
        // This is popping the luaL_getmetafield result which only pushes with type is not nil.
        this.pop(1)

        return name
    }

    public getValue(index: number, inputType?: LuaType, cache?: LuaGetCache): any {
        index = this.absIndex(index)

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
        const root = this.parent ?? this
        ;(root.onWarn ?? this.module.onWarn ?? defaultWarnHandler)(message, cause)
    }

    /** For identity checks on values JS cannot represent. */
    public getPointer(index: number): LuaAddress {
        return this.module.lua_topointer(this.address, index)
    }

    public isClosed(): boolean {
        return !this.address || this.closed || Boolean(this.parent?.isClosed())
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

        // This is the default message if there's nothing on the stack.
        let luaMessage = `Lua Error(${LuaReturn[result]}/${result})`
        let luaValue: unknown

        if (this.getTop() > 0) {
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
        const { deadline, maxInstructions, signal } = this.limits
        if (deadline === undefined && maxInstructions === undefined && signal === undefined) {
            this.module.lua_sethook(this.address, null, 0, 0)
            return
        }

        // A budget smaller than the default period would only ever be noticed late.
        this.hookCount =
            maxInstructions !== undefined ? Math.max(1, Math.min(INSTRUCTION_HOOK_COUNT, maxInstructions)) : INSTRUCTION_HOOK_COUNT

        if (!this.hookFunctionPointer) {
            this.hookFunctionPointer = this.module.addFunction((): void => {
                // Reads this.limits rather than closing over them, so a hook allocated for an
                // earlier configuration still honours the current one.
                const error = this.checkHookLimits()
                if (error) {
                    this.pushValue(error)
                    this.module.lua_error(this.address)
                }
            }, 'vii')
        }

        this.module.lua_sethook(this.address, this.hookFunctionPointer, LuaEventMasks.Count, this.hookCount)
    }

    private checkHookLimits(): Error | undefined {
        const { maxInstructions } = this.limits
        if (maxInstructions !== undefined) {
            this.instructionsUsed += this.hookCount
            if (this.instructionsUsed > maxInstructions) {
                return new LuaInstructionLimitError(`thread exceeded its budget of ${maxInstructions} instructions`)
            }
        }
        return this.checkYieldLimits()
    }

    private checkYieldLimits(): Error | undefined {
        const { deadline, signal } = this.limits
        if (signal?.aborted) {
            return new LuaAbortError('thread aborted')
        }
        if (deadline !== undefined && Date.now() > deadline) {
            return new LuaTimeoutError('thread timeout exceeded')
        }
        return undefined
    }

    /**
     * `lua_absindex` is the identity for an index that is already absolute, so the common case
     * skips the call into wasm.
     */
    private absIndex(index: number): number {
        return index > 0 ? index : this.module.lua_absindex(this.address, index)
    }

    /**
     * Whether a name belongs to a registered extension, which is what makes it safe to remember the
     * address of: those are the only ones the state keeps alive itself. Only reached the first time
     * a name is seen.
     */
    private isExtensionName(name: string): boolean {
        const extensions = this.typeExtensions
        for (let i = 0; i < extensions.length; i++) {
            if (extensions[i].extension.name === name) {
                return true
            }
        }
        return false
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
