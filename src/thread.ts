import {
    LuaState, LuaType, LUA_MULTRET, LUA_REGISTRYINDEX, LuaMetatables
} from './types'
import LuaWasm from './luawasm'
import Global from './global'
import MultiReturn from './multireturn'
import { Pointer } from './pointer'
import { Decoration } from './decoration'

export default class Thread {
    // Backward compatibility
    private readonly functionRegistry = typeof FinalizationRegistry !== 'undefined' ?
        new FinalizationRegistry((func: number) => {
            if (!this.closed) {
                this.cmodule.luaL_unref(this.address, LUA_REGISTRYINDEX, func)
            }
        }) : undefined

    private global: Global | this
    protected closed: boolean = false

    constructor(protected cmodule: LuaWasm, address: number, global: Global) {
        this.address = address
        this.global = global ?? this
    }

    public readonly address: LuaState = 0

    public get(name: string): any {
        const type = this.cmodule.lua_getglobal(this.address, name)
        return this.getValue(-1, type)
    }

    public set(name: string, value: any): void {
        this.pushValue(value)
        this.cmodule.lua_setglobal(this.address, name)
    }

    public call(name: string, ...args: any[]): any[] {
        const type = this.cmodule.lua_getglobal(this.address, name)
        if (type !== LuaType.Function) {
            throw new Error(`A function of type '${type}' was pushed, expected is ${LuaType.Function}`)
        }

        for (const arg of args) {
            this.pushValue(arg)
        }

        this.cmodule.lua_callk(this.address, args.length, LUA_MULTRET, 0, undefined)

        const returns = this.cmodule.lua_gettop(this.address) - 1
        const returnValues = new MultiReturn(returns)

        for (let i = 0; i < returns; i++) {
            returnValues[i] = this.getValue(i + 1)
        }

        return returnValues
    }

    public pushValue(value: any, options: Partial<{ _done?: Record<string, number> }> = {}): void {
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
                for (let i = 1; i <= argsQuantity; i++) {
                    args.push(thread.getValue(i, undefined, { raw: decorations?.rawArguments?.includes(i - 1) }))
                }

                const result = target(...args)

                if (result instanceof MultiReturn) {
                    for (const item of result) {
                        thread.pushValue(item)
                    }

                    return result.length
                } else {
                    thread.pushValue(result)
                    return 1
                }
            }, 'ii')
            // Creates a new userdata with metatable pointing to the function pointer.
            // Pushes the new userdata onto the stack.
            this.createAndPushFunctionReference(pointer);
            // Pass 1 to associate the closure with the userdata.
            this.cmodule.lua_pushcclosure(this.address, pointer, 1)
        } else {
            throw new Error(`The type '${type}' is not supported by Lua`)
        }
    }

    private createAndPushFunctionReference(pointer: number): void {
        // 4 = size of pointer in wasm.
        const userDataPointer = this.cmodule.lua_newuserdatauv(this.address, 4, 0);
        this.cmodule.module.setValue(userDataPointer, pointer, '*');

        if (LuaType.Nil === this.cmodule.luaL_getmetatable(this.address, LuaMetatables.FunctionReference)) {
          // Pop the pushed nil value
          this.cmodule.lua_pop(this.address, 1);
          throw new Error(`metatable not found: ${LuaMetatables.FunctionReference}`);
        }

        // Set as the metatable for the userdata.
        // -1 is the metatable, -2 is the user data.
        this.cmodule.lua_setmetatable(this.address, -2);
    }

    public getValue(
        idx: number,
        type: LuaType = undefined,
        options: Partial<{
            raw: boolean,
            _done: Record<string, number>
        }> = {}
    ): any {
        type = type || this.cmodule.lua_type(this.address, idx)

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

                    const jsFunc = (...args: any[]) => {
                        if (this.closed) {
                            console.warn('Tried to call a function after closing lua state')
                            return
                        }

                        const type = this.cmodule.lua_rawgeti(this.address, LUA_REGISTRYINDEX, func)
                        if (type !== LuaType.Function) {
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
            case LuaType.Thread:
                const value = this.cmodule.lua_tothread(this.address, idx)
                if (options.raw) {
                    return new Pointer(value)
                } else {
                    return this.stateToThread(value)
                }
            default:
                console.warn(`The type '${this.cmodule.lua_typename(this.address, type)}' returned is not supported on JS`)
                return new Pointer(this.cmodule.lua_topointer(this.address, idx))
        }
    }

    public dumpStack(log = console.log) {
        const top = this.cmodule.lua_gettop(this.address)

        for (let i = 1; i <= top; i++) {
            const type = this.cmodule.lua_type(this.address, i)
            const value = this.getValue(i, type, { raw: true })

            const typename = this.cmodule.lua_typename(this.address, type)
            log(i, typename, value)
        }
    }

    private getTableValue(idx: number, done: Record<string, any> = {}) {
        let table: Record<any, any> = {}

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

            this.cmodule.lua_settop(this.address, -1 - 1)
        }

        return table
    }

    private stateToThread(L: LuaState): Thread {
        return L === this.global.address ? this.global : new Thread(this.cmodule, L, this.global as Global)
    }

    private getValueDecorations(value: any): { value: any, decorations: any } {
        if (value instanceof Decoration) {
            return { value: value.target, decorations: value.options }
        }

        return { value, decorations: {} }
    }
}
