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
                LuaWasm.luaL_unref(this.address, LUA_REGISTRYINDEX, func)
            }
        }) : undefined

    private global: Global | this
    protected closed: boolean = false

    constructor(address: number, global: Global) {
        this.address = address
        this.global = global ?? this
    }

    public readonly address: LuaState = 0

    public get(name: string): any {
        const type = LuaWasm.lua_getglobal(this.address, name)
        return this.getValue(-1, type)
    }

    public set(name: string, value: any, options?: { metatable: number | string | object }): void {
        this.pushValue(value)

        if (options?.metatable) {
            if (typeof options.metatable === 'object') {
                this.pushValue(options.metatable)
            } else if (typeof options.metatable === 'string') {
                LuaWasm.lua_getglobal(this.address, options.metatable)
            } else if (typeof options.metatable === 'number') {
                LuaWasm.lua_pushvalue(this.address, options.metatable)
            }

            LuaWasm.lua_setmetatable(this.address, -2)
        }

        LuaWasm.lua_setglobal(this.address, name)
    }

    public call(name: string, ...args: any[]): any[] {
        const type = LuaWasm.lua_getglobal(this.address, name)
        if (type !== LuaType.Function) {
            throw new Error(`A function of type '${type}' was pushed, expected is ${LuaType.Function}`)
        }

        for (const arg of args) {
            this.pushValue(arg)
        }

        LuaWasm.clua_call(this.address, args.length, LUA_MULTRET)

        const returns = LuaWasm.lua_gettop(this.address)
        const returnValues = new MultiReturn(returns)

        for (let i = 1; i <= returns; i++) {
            returnValues[i - 1] = this.getValue(i)
        }

        return returnValues
    }

    public pushValue(value: any, done: AnyObject = {}): void {
        const type = typeof value

        if (done[value]) {
            LuaWasm.lua_pushvalue(this.address, done[value])
            return
        }

        if (type === 'undefined' || value === null) {
            LuaWasm.lua_pushnil(this.address)
        } else if (type === 'number') {
            if (Number.isInteger(value)) {
                LuaWasm.lua_pushinteger(this.address, value)
            } else {
                LuaWasm.lua_pushnumber(this.address, value)
            }
        } else if (type === 'string') {
            LuaWasm.lua_pushstring(this.address, value)
        } else if (type === 'boolean') {
            LuaWasm.lua_pushboolean(this.address, value)
        } else if (type === 'object') {
            if (value instanceof Thread) {
                LuaWasm.lua_pushthread(value.address)
            } else {
                LuaWasm.clua_newtable(this.address)

                const table = LuaWasm.lua_gettop(this.address)
                done[value] = table

                if (Array.isArray(value)) {
                    for (let i = 0; i < value.length; i++) {
                        this.pushValue(i + 1)
                        this.pushValue(value[i], done)

                        LuaWasm.lua_settable(this.address, table)
                    }
                } else {
                    for (const key in value) {
                        this.pushValue(key)
                        this.pushValue(value[key], done)

                        LuaWasm.lua_settable(this.address, table)
                    }
                }
            }
        } else if (type === 'function') {
            const pointer = LuaWasm.module.addFunction((calledL: LuaState) => {
                const argsQuantity = LuaWasm.lua_gettop(calledL)
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
            LuaWasm.clua_pushcfunction(this.address, pointer)
        } else {
            throw new Error(`The type '${type}' is not supported by Lua`)
        }
    }

    public getValue(idx: number, type: LuaType = undefined, done: { [key: number]: AnyObject } = {}): any {
        type = type || LuaWasm.lua_type(this.address, idx)

        switch (type) {
            case LuaType.None:
                return undefined
            case LuaType.Nil:
                return null
            case LuaType.Number:
                return LuaWasm.clua_tonumber(this.address, idx)
            case LuaType.String:
                return LuaWasm.clua_tostring(this.address, idx)
            case LuaType.Boolean:
                return LuaWasm.lua_toboolean(this.address, idx)
            case LuaType.Table:
                return this.getTableValue(idx, done)
            case LuaType.Function:
                LuaWasm.lua_pushvalue(this.address, idx)
                const func = LuaWasm.luaL_ref(this.address, LUA_REGISTRYINDEX)

                const jsFunc = (...args: any[]) => {
                    if (this.closed) {
                        console.warn('Tried to call a function after closing lua state')
                        return
                    }

                    const type = LuaWasm.lua_rawgeti(this.address, LUA_REGISTRYINDEX, func)
                    if (type !== LuaType.Function) {
                        throw new Error(`A function of type '${type}' was pushed, expected is ${LuaType.Function}`)
                    }

                    for (const arg of args) {
                        this.pushValue(arg)
                    }

                    LuaWasm.clua_call(this.address, args.length, 1)
                    return this.getValue(-1)
                }

                this.functionRegistry?.register(jsFunc, func)

                return jsFunc
            case LuaType.Thread:
                const value = LuaWasm.lua_tothread(this.address, idx)
                return this.stateToThread(value)
            default:
                throw new Error(`The type '${type}' returned is not supported on JS`)
        }
    }

    public dumpStack() {
        console.log(`Dumping Lua stack`)
        LuaWasm.clua_dump_stack(this.address)
    }

    private getTableValue(idx: number, done: { [key: number]: AnyObject } = {}) {
        let table: AnyObject = {}

        const pointer = LuaWasm.lua_topointer(this.address, idx)
        if (done[pointer]) {
            return done[pointer]
        }

        done[pointer] = table

        LuaWasm.lua_pushnil(this.address)

        if (idx < 0) {
            idx--
        }

        while (LuaWasm.lua_next(this.address, idx)) {
            const keyType = LuaWasm.lua_type(this.address, -2)
            const key = this.getValue(-2, keyType, done)

            const valueType = LuaWasm.lua_type(this.address, -1)
            const value = this.getValue(-1, valueType, done)

            table[key] = value

            LuaWasm.clua_pop(this.address, 1)
        }

        return table
    }

    private stateToThread(L: LuaState): Thread {
        return L === this.global.address ? this.global : new Thread(L, this.global as Global)
    }
}