import { Decoration } from './decoration'
import {
    LUA_MULTRET,
    LuaEventMasks,
    LuaResumeResult,
    LuaReturn,
    LuaState,
    LuaThreadRunOptions,
    LuaTimeoutError,
    LuaType,
    PointerSize,
} from './types'
import { Pointer } from './pointer'
import LuaTypeExtension from './type-extension'
import MultiReturn from './multireturn'
import type LuaWasm from './luawasm'

export interface OrderedExtension {
    // Bigger is more important
    priority: number
    extension: LuaTypeExtension<unknown>
}

// When the debug count hook is set, call it every X instructions.
const INSTRUCTION_HOOK_COUNT = 1000
// These reflect math.maxinteger and math.mininteger with 32 bit ints in Lua.
const MAX_SAFE_INTEGER = Math.pow(2, 31) - 1
const MIN_SAFE_INTEGER = -Math.pow(2, 31)

export default class Thread {
    public readonly address: LuaState
    public readonly lua: LuaWasm
    protected readonly typeExtensions: OrderedExtension[]
    private closed = false
    private hookFunctionPointer: number | undefined
    private timeout?: number
    private readonly parent?: Thread

    public constructor(lua: LuaWasm, typeExtensions: OrderedExtension[], address: number, parent?: Thread) {
        this.lua = lua
        this.typeExtensions = typeExtensions
        this.address = address
        this.parent = parent
    }

    public newThread(): Thread {
        const address = this.lua.lua_newthread(this.address)
        if (!address) {
            throw new Error('lua_newthread returned a null pointer')
        }
        return new Thread(this.lua, this.typeExtensions, address)
    }

    public resetThread(): void {
        this.assertOk(this.lua.lua_resetthread(this.address))
    }

    public loadString(luaCode: string, name?: string): void {
        const size = this.lua.module.lengthBytesUTF8(luaCode)
        const pointerSize = size + 1
        const bufferPointer = this.lua.module._malloc(pointerSize)
        try {
            this.lua.module.stringToUTF8(luaCode, bufferPointer, pointerSize)
            this.assertOk(this.lua.luaL_loadbufferx(this.address, bufferPointer, size, name ?? bufferPointer, null))
        } finally {
            this.lua.module._free(bufferPointer)
        }
    }

    public loadFile(filename: string): void {
        this.assertOk(this.lua.luaL_loadfilex(this.address, filename, null))
    }

    public resume(argCount = 0): LuaResumeResult {
        const dataPointer = this.lua.module._malloc(PointerSize)
        try {
            this.lua.module.setValue(dataPointer, 0, 'i32')
            const luaResult = this.lua.lua_resume(this.address, null, argCount, dataPointer)
            return {
                result: luaResult,
                resultCount: this.lua.module.getValue(dataPointer, 'i32'),
            }
        } finally {
            this.lua.module._free(dataPointer)
        }
    }

    public getTop(): number {
        return this.lua.lua_gettop(this.address)
    }

    public setTop(index: number): void {
        this.lua.lua_settop(this.address, index)
    }

    public remove(index: number): void {
        return this.lua.lua_remove(this.address, index)
    }

    public setField(index: number, name: string, value: unknown): void {
        index = this.lua.lua_absindex(this.address, index)
        this.pushValue(value)
        this.lua.lua_setfield(this.address, index, name)
    }

    public async run(argCount = 0, options?: Partial<LuaThreadRunOptions>): Promise<MultiReturn> {
        const originalTimeout = this.timeout
        try {
            if (options?.timeout !== undefined) {
                this.setTimeout(Date.now() + options.timeout)
            }
            let resumeResult: LuaResumeResult = this.resume(argCount)
            while (resumeResult.result === LuaReturn.Yield) {
                // If it's yielded check the timeout. If it's completed no need to
                // needlessly discard the output.
                if (this.timeout && Date.now() > this.timeout) {
                    if (resumeResult.resultCount > 0) {
                        this.pop(resumeResult.resultCount)
                    }
                    throw new LuaTimeoutError(`thread timeout exceeded`)
                }
                if (resumeResult.resultCount > 0) {
                    const lastValue = this.getValue(-1)
                    this.pop(resumeResult.resultCount)

                    // If there's a result and it's a promise, then wait for it.
                    if (lastValue === Promise.resolve(lastValue)) {
                        await lastValue
                    } else {
                        // If it's a non-promise, then skip a tick to yield for promises, timers, etc.
                        await new Promise((resolve) => setImmediate(resolve))
                    }
                } else {
                    // If there's nothing to yield, then skip a tick to yield for promises, timers, etc.
                    await new Promise((resolve) => setImmediate(resolve))
                }

                resumeResult = this.resume(0)
            }

            this.assertOk(resumeResult.result)
            return this.getStackValues()
        } finally {
            if (options?.timeout !== undefined) {
                this.setTimeout(originalTimeout)
            }
        }
    }

    public runSync(argCount = 0): MultiReturn {
        const base = this.getTop() - argCount - 1 // The 1 is for the function to run
        this.assertOk(this.lua.lua_pcallk(this.address, argCount, LUA_MULTRET, 0, 0, null) as LuaReturn)
        return this.getStackValues(base)
    }

    public pop(count = 1): void {
        this.lua.lua_pop(this.address, count)
    }

    public call(name: string, ...args: any[]): MultiReturn {
        const type = this.lua.lua_getglobal(this.address, name)
        if (type !== LuaType.Function) {
            throw new Error(`A function of type '${type}' was pushed, expected is ${LuaType.Function}`)
        }

        for (const arg of args) {
            this.pushValue(arg)
        }

        const base = this.getTop() - args.length - 1 // The 1 is for the function to run
        this.lua.lua_callk(this.address, args.length, LUA_MULTRET, 0, null)
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

    public stateToThread(L: LuaState): Thread {
        return L === this.parent?.address ? this.parent : new Thread(this.lua, this.typeExtensions, L, this.parent || this)
    }

    public pushValue(rawValue: unknown, userdata?: unknown): void {
        const decoratedValue = this.getValueDecorations(rawValue)
        const target = decoratedValue.target ?? undefined

        if (target instanceof Thread) {
            const isMain = this.lua.lua_pushthread(target.address) === 1
            if (!isMain) {
                this.lua.lua_xmove(target.address, this.address, 1)
            }
            return
        }

        const startTop = this.getTop()

        // Handle primitive types
        switch (typeof target) {
            case 'undefined':
                this.lua.lua_pushnil(this.address)
                break
            case 'number':
                // Only push it as an integer if it fits within 32 bits, otherwise treat it as a double.
                // This is because wasm doesn't support 32 bit ints but does support 64 bit floats.
                if (Number.isInteger(target) && target <= MAX_SAFE_INTEGER && target >= MIN_SAFE_INTEGER) {
                    this.lua.lua_pushinteger(this.address, target)
                } else {
                    this.lua.lua_pushnumber(this.address, target)
                }
                break
            case 'string':
                this.lua.lua_pushstring(this.address, target)
                break
            case 'boolean':
                this.lua.lua_pushboolean(this.address, target ? 1 : 0)
                break
            default:
                if (!this.typeExtensions.find((wrapper) => wrapper.extension.pushValue(this, decoratedValue, userdata))) {
                    throw new Error(`The type '${typeof target}' is not supported by Lua`)
                }
        }

        if (decoratedValue.options.metatable) {
            this.setMetatable(-1, decoratedValue.options.metatable)
        }

        if (this.getTop() !== startTop + 1) {
            throw new Error(`pushValue expected stack size ${startTop + 1}, got ${this.getTop()}`)
        }
    }

    public setMetatable(index: number, metatable: Record<any, any>): void {
        index = this.lua.lua_absindex(this.address, index)

        if (this.lua.lua_getmetatable(this.address, index)) {
            this.pop(1)
            const name = this.getMetatableName(index)
            throw new Error(`data already has associated metatable: ${name || 'unknown name'}`)
        }

        this.pushValue(metatable)
        this.lua.lua_setmetatable(this.address, index)
    }

    public getMetatableName(index: number): string | undefined {
        const metatableNameType = this.lua.luaL_getmetafield(this.address, index, '__name')
        if (metatableNameType === LuaType.Nil) {
            return undefined
        }

        if (metatableNameType !== LuaType.String) {
            // Pop the metafield if it's not a string
            this.pop(1)
            return undefined
        }

        const name = this.lua.lua_tolstring(this.address, -1, null)
        // This is popping the luaL_getmetafield result which only pushes with type is not nil.
        this.pop(1)

        return name
    }

    public getValue(index: number, inputType?: LuaType, userdata?: unknown): any {
        index = this.lua.lua_absindex(this.address, index)

        const type: LuaType = inputType ?? this.lua.lua_type(this.address, index)

        switch (type) {
            case LuaType.None:
                return undefined
            case LuaType.Nil:
                return null
            case LuaType.Number:
                return this.lua.lua_tonumberx(this.address, index, null)
            case LuaType.String:
                return this.lua.lua_tolstring(this.address, index, null)
            case LuaType.Boolean:
                return Boolean(this.lua.lua_toboolean(this.address, index))
            case LuaType.Thread:
                return this.stateToThread(this.lua.lua_tothread(this.address, index))
            default: {
                let metatableName: string | undefined
                if (type === LuaType.Table || type === LuaType.Userdata) {
                    metatableName = this.getMetatableName(index)
                }

                const typeExtensionWrapper = this.typeExtensions.find((wrapper) =>
                    wrapper.extension.isType(this, index, type, metatableName),
                )
                if (typeExtensionWrapper) {
                    return typeExtensionWrapper.extension.getValue(this, index, userdata)
                }

                // Fallthrough if unrecognised user data
                console.warn(`The type '${this.lua.lua_typename(this.address, type)}' returned is not supported on JS`)
                return new Pointer(this.lua.lua_topointer(this.address, index))
            }
        }
    }

    public close(): void {
        if (this.isClosed()) {
            return
        }

        if (this.hookFunctionPointer) {
            this.lua.module.removeFunction(this.hookFunctionPointer)
        }

        this.closed = true
    }

    // Set to > 0 to enable, otherwise disable.
    public setTimeout(timeout: number | undefined): void {
        if (timeout && timeout > 0) {
            if (!this.hookFunctionPointer) {
                this.hookFunctionPointer = this.lua.module.addFunction((): void => {
                    if (Date.now() > timeout) {
                        this.pushValue(new LuaTimeoutError(`thread timeout exceeded`))
                        this.lua.lua_error(this.address)
                    }
                }, 'vii')
            }

            this.lua.lua_sethook(this.address, this.hookFunctionPointer, LuaEventMasks.Count, INSTRUCTION_HOOK_COUNT)
            this.timeout = timeout
        } else if (this.hookFunctionPointer) {
            this.hookFunctionPointer = undefined
            this.timeout = undefined
            this.lua.lua_sethook(this.address, null, 0, 0)
        }
    }

    public getTimeout(): number | undefined {
        return this.timeout
    }

    public getPointer(index: number): Pointer {
        return new Pointer(this.lua.lua_topointer(this.address, index))
    }

    public isClosed(): boolean {
        return !this.address || this.closed || Boolean(this.parent?.isClosed())
    }

    public indexToString(index: number): string {
        const str = this.lua.luaL_tolstring(this.address, index, null)
        // Pops the string pushed by luaL_tolstring
        this.pop()
        return str
    }

    public dumpStack(log = console.log): void {
        const top = this.getTop()

        for (let i = 1; i <= top; i++) {
            const type = this.lua.lua_type(this.address, i)
            const typename = this.lua.lua_typename(this.address, type)
            const pointer = this.getPointer(i)
            const name = this.indexToString(i)
            const value = this.getValue(i, type)

            log(i, typename, pointer, name, value)
        }
    }

    public assertOk(result: LuaReturn): void {
        if (result !== LuaReturn.Ok && result !== LuaReturn.Yield) {
            const resultString = LuaReturn[result]
            // This is the default message if there's nothing on the stack.
            const error = new Error(`Lua Error(${resultString}/${result})`)
            if (this.getTop() > 0) {
                if (result === LuaReturn.ErrorMem) {
                    // If there's no memory just do a normal to string.
                    error.message = this.lua.lua_tolstring(this.address, -1, null)
                } else {
                    const luaError = this.getValue(-1)
                    if (luaError instanceof Error) {
                        error.stack = luaError.stack
                    }

                    // Calls __tostring if it exists and pushes onto the stack.
                    error.message = this.indexToString(-1)
                }
            }

            // Also attempt to get a traceback
            if (result !== LuaReturn.ErrorMem) {
                try {
                    this.lua.luaL_traceback(this.address, this.address, null, 1)
                    const traceback = this.lua.lua_tolstring(this.address, -1, null)
                    if (traceback.trim() !== 'stack traceback:') {
                        error.message = `${error.message}\n${traceback}`
                    }
                    this.pop(1) // pop stack trace.
                } catch (err) {
                    console.warn('Failed to generate stack trace', err)
                }
            }

            throw error
        }
    }

    private getValueDecorations(value: any): Decoration {
        return value instanceof Decoration ? value : new Decoration(value, {})
    }
}
