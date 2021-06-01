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

export default class Thread {
    public readonly address: LuaState = 0
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

    public loadString(luaCode: string): void {
        this.assertOk(this.lua.luaL_loadstring(this.address, luaCode))
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

    public setField(index: number, name: string, value: any): void {
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
        this.assertOk(this.lua.lua_pcallk(this.address, argCount, LUA_MULTRET, 0, 0, null) as LuaReturn)
        return this.getStackValues()
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

        this.lua.lua_callk(this.address, args.length, LUA_MULTRET, 0, null)
        return this.getStackValues()
    }

    public getStackValues(): MultiReturn {
        const returns = this.getTop()
        const returnValues = new MultiReturn(returns)

        for (let i = 0; i < returns; i++) {
            returnValues[i] = this.getValue(i + 1)
        }

        return returnValues
    }

    public stateToThread(L: LuaState): Thread {
        return L === this.parent?.address ? this.parent : new Thread(this.lua, this.typeExtensions, L, this.parent || this)
    }

    public pushValue(rawValue: any, userdata?: any): void {
        const decoratedValue = this.getValueDecorations(rawValue)
        const options = decoratedValue.options
        let target = decoratedValue.target

        if (target instanceof Thread) {
            const isMain = this.lua.lua_pushthread(target.address) === 1
            if (!isMain) {
                this.lua.lua_xmove(target.address, this.address, 1)
            }
            return
        }

        const startTop = this.getTop()
        // First to allow overriding default behaviour, except for threads
        if (!this.typeExtensions.find((wrapper) => wrapper.extension.pushValue(this, decoratedValue, userdata))) {
            if (target === null) {
                target = undefined
            }

            switch (typeof target) {
                case 'undefined':
                    this.lua.lua_pushnil(this.address)
                    break
                case 'number':
                    if (Number.isInteger(target)) {
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
                    throw new Error(`The type '${typeof target}' is not supported by Lua`)
            }
        }

        if (options?.metatable) {
            this.setMetatable(options.metatable, -1)
        }

        if (this.getTop() !== startTop + 1) {
            throw new Error(`pushValue expected stack size ${startTop + 1}, got ${this.getTop()}`)
        }
    }

    public setMetatable(metatable: Record<any, any>, index: number): void {
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

    public getValue(idx: number, inputType: LuaType | undefined = undefined, userdata?: any): any {
        idx = this.lua.lua_absindex(this.address, idx)

        // Before the below to allow overriding default behaviour.
        const metatableName = this.getMetatableName(idx)
        const type: LuaType = inputType || this.lua.lua_type(this.address, idx)

        const typeExtensionWrapper = this.typeExtensions.find((wrapper) => wrapper.extension.isType(this, idx, type, metatableName))
        if (typeExtensionWrapper) {
            return typeExtensionWrapper.extension.getValue(this, idx, userdata)
        }

        switch (type) {
            case LuaType.None:
                return undefined
            case LuaType.Nil:
                return null
            case LuaType.Number:
                return this.lua.lua_tonumberx(this.address, idx, null)
            case LuaType.String:
                return this.lua.lua_tolstring(this.address, idx, null)
            case LuaType.Boolean:
                return Boolean(this.lua.lua_toboolean(this.address, idx))
            case LuaType.Thread: {
                return this.stateToThread(this.lua.lua_tothread(this.address, idx))
            }
            // Fallthrough if unrecognised user data
            default:
                console.warn(`The type '${this.lua.lua_typename(this.address, type)}' returned is not supported on JS`)
                return new Pointer(this.lua.lua_topointer(this.address, idx))
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
        } else {
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
            let message = `Lua Error(${resultString}/${result})`
            if (this.getTop() > 0) {
                if (result === LuaReturn.ErrorMem) {
                    // If there's no memory just do a normal to string.
                    const error = this.lua.lua_tolstring(this.address, -1, null)
                    message = error
                } else {
                    // Calls __tostring if it exists and pushes onto the stack.
                    const error = this.indexToString(-1)
                    message = error
                }
            }
            throw new Error(message)
        }
    }

    private getValueDecorations(value: any): Decoration {
        return value instanceof Decoration ? value : new Decoration(value, {})
    }
}
