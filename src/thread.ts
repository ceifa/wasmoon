import { Decoration } from './decoration'
import { LUA_MULTRET, LUA_REGISTRYINDEX, LuaMetatables, LuaResumeResult, LuaReturn, LuaState, LuaType, PointerSize } from './types'
import { Pointer } from './pointer'
import LuaTypeExtension from './type-extension'
import MultiReturn from './multireturn'
import type Global from './global'
import type LuaWasm from './luawasm'

export default class Thread {
    public readonly address: LuaState = 0
    public readonly cmodule: LuaWasm
    protected typeExtensions: Array<LuaTypeExtension<unknown>>
    private closed = false
    // Backward compatibility
    private readonly functionRegistry =
        typeof FinalizationRegistry !== 'undefined'
            ? new FinalizationRegistry((func: number) => {
                  if (!this.closed) {
                      this.cmodule.luaL_unref(this.address, LUA_REGISTRYINDEX, func)
                  }
              })
            : undefined

    private global: Global | this

    public constructor(cmodule: LuaWasm, typeExtensions: Array<LuaTypeExtension<unknown>>, address: number, global?: Global) {
        this.cmodule = cmodule
        this.typeExtensions = typeExtensions
        this.address = address
        this.global = global ?? this
    }

    public get(name: string): any {
        const type = this.cmodule.lua_getglobal(this.address, name)
        return this.getValue(-1, type)
    }

    public set(name: string, value: any): void {
        this.pushValue(value)
        this.cmodule.lua_setglobal(this.address, name)
    }

    public newThread(): Thread {
        return new Thread(this.cmodule, this.typeExtensions, this.cmodule.lua_newthread(this.address))
    }

    public resetThread(): void {
        this.assertOk(this.cmodule.lua_resetthread(this.address))
    }

    public loadString(luaCode: string): void {
        this.assertOk(this.cmodule.luaL_loadstring(this.address, luaCode))
    }

    public loadFile(filename: string): void {
        this.assertOk(this.cmodule.luaL_loadfilex(this.address, filename))
    }

    public resume(argCount = 0): LuaResumeResult {
        const resumeResult = this.cmodule.lua_resume(this.address, undefined, argCount)
        this.assertOk(resumeResult.result)
        return resumeResult
    }

    public getTop(): number {
        return this.cmodule.lua_gettop(this.address)
    }

    public remove(index: number): void {
        return this.cmodule.lua_remove(this.address, index)
    }

    public async run(argCount = 0): Promise<MultiReturn> {
        let resumeResult: LuaResumeResult = this.resume(argCount)
        while (resumeResult.result === LuaReturn.Yield) {
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
                await new Promise((resolve) => setImmediate(resolve, 0))
            }

            resumeResult = this.resume(0)
        }
        return this.getStackValues()
    }

    public pop(count = 1): void {
        this.cmodule.lua_pop(this.address, count)
    }

    public call(name: string, ...args: any[]): MultiReturn {
        const type = this.cmodule.lua_getglobal(this.address, name)
        if (type !== LuaType.Function) {
            throw new Error(`A function of type '${type}' was pushed, expected is ${LuaType.Function}`)
        }

        for (const arg of args) {
            this.pushValue(arg)
        }

        this.cmodule.lua_callk(this.address, args.length, LUA_MULTRET, 0, undefined)
        return this.getStackValues()
    }

    public getStackValues(): MultiReturn {
        const returns = this.cmodule.lua_gettop(this.address)
        const returnValues = new MultiReturn(returns)

        for (let i = 0; i < returns; i++) {
            returnValues[i] = this.getValue(i + 1)
        }

        return returnValues
    }

    public stateToThread(L: LuaState): Thread {
        return L === this.global.address ? this.global : new Thread(this.cmodule, this.typeExtensions, L, this.global as Global)
    }

    public pushValue(value: any, options: Partial<{ _done?: Record<string, number> }> = {}): void {
        // First to allow overriding default behaviour
        if (this.typeExtensions.find((extension) => extension.pushValue(this, value))) {
            return
        }

        const { value: target, decorations } = this.getValueDecorations(value)

        const type = typeof target

        if (options?._done?.[target]) {
            this.cmodule.lua_pushvalue(this.address, options._done[target])
            return
        }

        if (type === 'undefined' || target === null) {
            this.cmodule.lua_pushnil(this.address)
        } else if (type === 'number') {
            if (Number.isInteger(target)) {
                this.cmodule.lua_pushinteger(this.address, target)
            } else {
                this.cmodule.lua_pushnumber(this.address, target)
            }
        } else if (type === 'string') {
            this.cmodule.lua_pushstring(this.address, target)
        } else if (type === 'boolean') {
            this.cmodule.lua_pushboolean(this.address, target)
        } else if (type === 'object') {
            if (target instanceof Thread) {
                this.cmodule.lua_pushthread(target.address)
            } else {
                const table = this.cmodule.lua_gettop(this.address) + 1

                options._done ??= {}
                options._done[target] = table

                if (Array.isArray(target)) {
                    this.cmodule.lua_createtable(this.address, target.length, 0)

                    for (let i = 0; i < target.length; i++) {
                        this.pushValue(i + 1)
                        this.pushValue(target[i], { _done: options._done })

                        this.cmodule.lua_settable(this.address, table)
                    }
                } else {
                    this.cmodule.lua_createtable(this.address, 0, Object.getOwnPropertyNames(target).length)

                    for (const key in target) {
                        this.pushValue(key)
                        this.pushValue(target[key], { _done: options._done })

                        this.cmodule.lua_settable(this.address, table)
                    }
                }

                if (typeof decorations.metatable === 'object') {
                    this.pushValue(decorations.metatable)
                    this.cmodule.lua_setmetatable(this.address, -2)
                }
            }
        } else if (type === 'function') {
            const pointer = this.cmodule.module.addFunction((calledL: LuaState) => {
                const argsQuantity = this.cmodule.lua_gettop(calledL)
                const args = []

                const thread = this.stateToThread(calledL)

                if (decorations.receiveThread) {
                    args.push(thread)
                }

                for (let i = 1; i <= argsQuantity; i++) {
                    args.push(thread.getValue(i, undefined, { raw: decorations?.rawArguments?.includes(i - 1) }))
                }

                if (decorations.rawResult) {
                    // Interestingly yieldk does a longjmp and that's handled
                    // by throwing an error. So for anything that yields it needs
                    // to not be in the try/catch.
                    const result = target(...args)
                    if (typeof result !== 'number') {
                        throw new Error('result must be a number')
                    }
                    return result
                }

                try {
                    const result = target(...args)

                    if (result === undefined) {
                        return 0
                    }
                    if (result instanceof MultiReturn) {
                        for (const item of result) {
                            thread.pushValue(item)
                        }
                        return result.length
                    } else {
                        thread.pushValue(result)
                        return 1
                    }
                } catch (err) {
                    thread.pushValue(err)
                    return this.cmodule.lua_error(thread.address)
                }
            }, 'ii')
            // Creates a new userdata with metatable pointing to the function pointer.
            // Pushes the new userdata onto the stack.
            this.createAndPushFunctionReference(pointer)
            // Pass 1 to associate the closure with the userdata.
            this.cmodule.lua_pushcclosure(this.address, pointer, 1)
        } else {
            throw new Error(`The type '${type}' is not supported by Lua`)
        }
    }

    public getMetatableName(index: number): string | undefined {
        const metatableNameType = this.cmodule.luaL_getmetafield(this.address, index, '__name')
        if (metatableNameType === LuaType.Nil) {
            return undefined
        }

        if (metatableNameType !== LuaType.String) {
            // Pop the metafield if it's not a string
            this.pop(1)
            return undefined
        }

        const name = this.cmodule.lua_tolstring(this.address, -1)
        // This is popping the luaL_getmetafield result which only pushes with type is not nil.
        this.pop(1)

        return name
    }

    public getValue(
        idx: number,
        inputType: LuaType | undefined = undefined,
        options: Partial<{
            raw: boolean
            _done: Record<string, number>
        }> = {},
    ): any {
        // Before the below to allow overriding default behaviour.
        const metatableName = this.getMetatableName(idx)
        const type: LuaType = inputType || this.cmodule.lua_type(this.address, idx)

        const typeExtension = this.typeExtensions.find((extension) => extension.isType(this, idx, type, metatableName))
        if (typeExtension) {
            return typeExtension.getValue(this, idx)
        }

        switch (type) {
            case LuaType.None:
                return undefined
            case LuaType.Nil:
                return null
            case LuaType.Number:
                return this.cmodule.lua_tonumberx(this.address, idx, undefined)
            case LuaType.String:
                return this.cmodule.lua_tolstring(this.address, idx, undefined)
            case LuaType.Boolean:
                return Boolean(this.cmodule.lua_toboolean(this.address, idx))
            case LuaType.Table:
                if (options.raw) {
                    return new Pointer(this.cmodule.lua_topointer(this.address, idx))
                } else {
                    return this.getTableValue(idx, options?._done)
                }
            case LuaType.Function:
                if (options.raw) {
                    return new Pointer(this.cmodule.lua_topointer(this.address, idx))
                } else {
                    this.cmodule.lua_pushvalue(this.address, idx)
                    const func = this.cmodule.luaL_ref(this.address, LUA_REGISTRYINDEX)

                    const jsFunc = (...args: any[]): any => {
                        if (this.closed) {
                            console.warn('Tried to call a function after closing lua state')
                            return
                        }

                        const internalType = this.cmodule.lua_rawgeti(this.address, LUA_REGISTRYINDEX, func)
                        if (internalType !== LuaType.Function) {
                            throw new Error(`A function of type '${type}' was pushed, expected is ${LuaType.Function}`)
                        }

                        for (const arg of args) {
                            this.pushValue(arg)
                        }

                        this.cmodule.lua_callk(this.address, args.length, 1, 0, undefined)
                        return this.getValue(-1)
                    }

                    this.functionRegistry?.register(jsFunc, func)

                    return jsFunc
                }
            case LuaType.Thread: {
                const value = this.cmodule.lua_tothread(this.address, idx)
                if (options.raw) {
                    return new Pointer(value)
                } else {
                    return this.stateToThread(value)
                }
            }
            // Fallthrough if unrecognised user data
            default:
                console.warn(`The type '${this.cmodule.lua_typename(this.address, type)}' returned is not supported on JS`)
                return new Pointer(this.cmodule.lua_topointer(this.address, idx))
        }
    }

    public close(): void {
        if (!this.closed) {
            return
        }

        this.closed = true
        // Do this before removing the gc to force
        this.cmodule.lua_close(this.address)
    }

    public isClosed(): boolean {
        return !this.address || this.closed
    }

    public dumpStack(log = console.log): void {
        const top = this.cmodule.lua_gettop(this.address)

        for (let i = 1; i <= top; i++) {
            const type = this.cmodule.lua_type(this.address, i)
            const value = this.getValue(i, type, { raw: true })

            const typename = this.cmodule.lua_typename(this.address, type)
            log(i, typename, value)
        }
    }

    private assertOk(result: LuaReturn): void {
        if (result !== LuaReturn.Ok && result !== LuaReturn.Yield) {
            const resultString = LuaReturn[result]
            let message = `Lua Error(${resultString}/${result})`
            if (this.cmodule.lua_gettop(this.address) > 0) {
                if (result === LuaReturn.ErrorMem) {
                    // If there's no memory just do a normal to string.
                    const error = this.cmodule.lua_tolstring(this.address, -1)
                    message += `: ${error}`
                } else {
                    // Calls __tostring if it exists and pushes onto the stack.
                    const error = this.cmodule.luaL_tolstring(this.address, -1)
                    message += `: ${error}`
                    // Pops the string pushed by luaL_tolstring
                    this.pop()
                }
            }
            throw new Error(message)
        }
    }

    private getTableValue(idx: number, done: Record<string, any> = {}): Record<any, any> | any[] {
        const table: Record<any, any> = {}

        const pointer = this.cmodule.lua_topointer(this.address, idx)
        if (done[pointer]) {
            return done[pointer]
        }

        done[pointer] = table

        this.cmodule.lua_pushnil(this.address)

        if (idx < 0) {
            idx--
        }

        while (this.cmodule.lua_next(this.address, idx)) {
            const keyType = this.cmodule.lua_type(this.address, -2)
            const key = this.getValue(-2, keyType, { _done: done })

            const valueType = this.cmodule.lua_type(this.address, -1)
            const value = this.getValue(-1, valueType, { _done: done })

            table[key] = value

            this.pop()
        }

        const tableLength = Object.keys(table).length
        // Specifically return an object if there's no way of telling whether
        // it's an array or object.
        if (tableLength === 0) {
            return {}
        }

        let isArray = true
        const array: any[] = []
        for (let i = 1; i <= tableLength; i++) {
            const value = table[String(i)]
            if (value === undefined) {
                isArray = false
                break
            }
            array.push(value)
        }

        return isArray ? array : table
    }

    private createAndPushFunctionReference(pointer: number): void {
        // 4 = size of pointer in wasm.
        const userDataPointer = this.cmodule.lua_newuserdatauv(this.address, PointerSize, 0)
        this.cmodule.module.setValue(userDataPointer, pointer, '*')

        if (LuaType.Nil === this.cmodule.luaL_getmetatable(this.address, LuaMetatables.FunctionReference)) {
            // Pop the pushed nil value and user data
            this.pop(2)
            throw new Error(`metatable not found: ${LuaMetatables.FunctionReference}`)
        }

        // Set as the metatable for the userdata.
        // -1 is the metatable, -2 is the user data.
        this.cmodule.lua_setmetatable(this.address, -2)
    }

    private getValueDecorations(value: any): { value: any; decorations: any } {
        return value instanceof Decoration ? { value: value.target, decorations: value.options } : { value, decorations: {} }
    }
}
