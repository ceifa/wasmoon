import {
    AnyObject, LuaState, LuaType, LUA_MULTRET, LUA_REGISTRYINDEX
} from './types'
import LuaWasm from './luawasm'
import Global from './global'
import MultiReturn from './multireturn'

export default class Thread {
    // Backward compatibility
    private readonly functionRegistry = typeof FinalizationRegistry !== 'undefined' ?
        new FinalizationRegistry((func: number) => {
            if (!this.closed) {
                this.module.luaL_unref(this.address, LUA_REGISTRYINDEX, func)
            }
        }) : undefined

    private global: Global | this
    protected closed: boolean = false

    constructor(protected module: LuaWasm, address: number, global: Global) {
        this.address = address
        this.global = global ?? this
    }

    public readonly address: LuaState = 0

    public get(name: string): any {
        const type = this.module.lua_getglobal(this.address, name)
        return this.getValue(-1, type)
    }

    public set(name: string, value: any, options: Partial<{ metatable: number | string | object }> = {}): void {
        this.pushValue(value)

        if (options.metatable) {
            if (typeof options.metatable === 'object') {
                this.pushValue(options.metatable)
            } else if (typeof options.metatable === 'string') {
                this.module.lua_getglobal(this.address, options.metatable)
            } else if (typeof options.metatable === 'number') {
                this.module.lua_pushvalue(this.address, options.metatable)
            }

            this.module.lua_setmetatable(this.address, -2)
        }

        this.module.lua_setglobal(this.address, name)
    }

    public call(name: string, ...args: any[]): any[] {
        const type = this.module.lua_getglobal(this.address, name)
        if (type !== LuaType.Function) {
            throw new Error(`A function of type '${type}' was pushed, expected is ${LuaType.Function}`)
        }

        for (const arg of args) {
            this.pushValue(arg)
        }

        this.module.lua_callk(this.address, args.length, LUA_MULTRET, 0, undefined)

        const returns = this.module.lua_gettop(this.address) - 1
        const returnValues = new MultiReturn(returns)

        for (let i = 0; i < returns; i++) {
            returnValues[i] = this.getValue(i + 1)
        }

        return returnValues
    }

    public pushValue(value: any, options: Partial<{ _done?: AnyObject }> = {}): void {
        const type = typeof value

        if (options?._done?.[value]) {
            this.module.lua_pushvalue(this.address, options._done[value])
            return
        }

        if (type === 'undefined' || value === null) {
            this.module.lua_pushnil(this.address)
        } else if (type === 'number') {
            if (Number.isInteger(value)) {
                this.module.lua_pushinteger(this.address, value)
            } else {
                this.module.lua_pushnumber(this.address, value)
            }
        } else if (type === 'string') {
            this.module.lua_pushstring(this.address, value)
        } else if (type === 'boolean') {
            this.module.lua_pushboolean(this.address, value)
        } else if (type === 'object') {
            if (value instanceof Thread) {
                this.module.lua_pushthread(value.address)
            } else {
                const table = this.module.lua_gettop(this.address) + 1

                options._done ??= {}
                options._done[value] = table

                if (Array.isArray(value)) {
                    this.module.lua_createtable(this.address, value.length, 0)

                    for (let i = 0; i < value.length; i++) {
                        this.pushValue(i + 1)
                        this.pushValue(value[i], { _done: options._done })

                        this.module.lua_settable(this.address, table)
                    }
                } else {
                    this.module.lua_createtable(this.address, 0, Object.getOwnPropertyNames(value).length)

                    for (const key in value) {
                        this.pushValue(key)
                        this.pushValue(value[key], { _done: options._done })

                        this.module.lua_settable(this.address, table)
                    }
                }
            }
        } else if (type === 'function') {
            const pointer = this.module.module.addFunction((calledL: LuaState) => {
                const argsQuantity = this.module.lua_gettop(calledL)
                const args = []

                const thread = this.stateToThread(calledL)
                for (let i = 1; i <= argsQuantity; i++) {
                    args.push(thread.getValue(i))
                }

                const result = value(...args)

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
            this.module.lua_pushcclosure(this.address, pointer, 0)
        } else {
            throw new Error(`The type '${type}' is not supported by Lua`)
        }
    }

    public getValue(
        idx: number,
        type: LuaType = undefined,
        options: Partial<{
            raw: boolean,
            _done: AnyObject
        }> = {}
    ): any {
    
        type = type || this.module.lua_type(this.address, idx)

        switch (type) {
            case LuaType.None:
                return undefined
            case LuaType.Nil:
                return null
            case LuaType.Number:
                return this.module.lua_tonumberx(this.address, idx, undefined)
            case LuaType.String:
                return this.module.lua_tolstring(this.address, idx, undefined)
            case LuaType.Boolean:
                return Boolean(this.module.lua_toboolean(this.address, idx))
            case LuaType.Table:
                return this.getTableValue(idx, options?._done)
            case LuaType.Function:
                if (options.raw) {
                    this.module.lua_topointer(this.address, idx)
                } else {
                    this.module.lua_pushvalue(this.address, idx)
                    const func = this.module.luaL_ref(this.address, LUA_REGISTRYINDEX)
    
                    const jsFunc = (...args: any[]) => {
                        if (this.closed) {
                            console.warn('Tried to call a function after closing lua state')
                            return
                        }
    
                        const type = this.module.lua_rawgeti(this.address, LUA_REGISTRYINDEX, func)
                        if (type !== LuaType.Function) {
                            throw new Error(`A function of type '${type}' was pushed, expected is ${LuaType.Function}`)
                        }
    
                        for (const arg of args) {
                            this.pushValue(arg)
                        }
    
                        this.module.lua_callk(this.address, args.length, 1, 0, undefined)
                        return this.getValue(-1)
                    }
    
                    this.functionRegistry?.register(jsFunc, func)
    
                    return jsFunc
                }
            case LuaType.Thread:
                const value = this.module.lua_tothread(this.address, idx)
                if (options.raw) {
                    return value
                } else {
                    return this.stateToThread(value)
                }
            default:
                console.warn(`The type '${this.module.lua_typename(this.address, type)}' returned is not supported on JS`)
                return this.module.lua_topointer(this.address, idx)
        }
    }

    public dumpStack(log = console.log) {
        const top = this.module.lua_gettop(this.address)

        for (let i = 1; i <= top; i++) {
            const type = this.module.lua_type(this.address, i)
            const value = this.getValue(i, type, { raw: true })

            const typename = this.module.lua_typename(this.address, type)
            log(i, typename, value)
        }
    }

    private getTableValue(idx: number, done: AnyObject = {}) {
        let table: AnyObject = {}

        const pointer = this.module.lua_topointer(this.address, idx)
        if (done[pointer]) {
            return done[pointer]
        }

        done[pointer] = table

        this.module.lua_pushnil(this.address)

        if (idx < 0) {
            idx--
        }

        while (this.module.lua_next(this.address, idx)) {
            const keyType = this.module.lua_type(this.address, -2)
            const key = this.getValue(-2, keyType, { _done: done })

            const valueType = this.module.lua_type(this.address, -1)
            const value = this.getValue(-1, valueType, { _done: done })

            table[key] = value

            this.module.lua_settop(this.address, -1 - 1)
        }

        return table
    }

    private stateToThread(L: LuaState): Thread {
        return L === this.global.address ? this.global : new Thread(this.module, L, this.global as Global)
    }
}