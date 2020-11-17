import LuaWasm from './luawasm'
import {
    Thread, AnyObject, LuaReturn, LuaState, LuaType, LUA_MULTRET, LUA_REGISTRYINDEX
} from './types'

export default class Lua extends LuaWasm {
    // Backward compatibility
    private readonly functionRegistry = typeof FinalizationRegistry !== 'undefined' ?
        new FinalizationRegistry((func: number) => {
            if (!this.isClosed) {
                Lua.luaL_unref(this.Main, LUA_REGISTRYINDEX, func)
            }
        }) : undefined

    private Main: LuaState

    constructor() {
        super()
        this.Main = Lua.luaL_newstate()

        if (this.isClosed) {
            throw new Error("Lua state could not be created (probably due to lack of memory)")
        }
    }

    public registerStandardLib() {
        Lua.luaL_openlibs(this.Main)
    }

    public doString(script: string): any {
        const result = Lua.clua_dostring(this.Main, script)
        if (result !== LuaReturn.Ok) {
            const error = Lua.clua_tostring(this.Main, -1)
            throw new Error('Lua error: ' + error)
        }

        return this.getValue(this.Main, 1)
    }

    public getGlobal(name: string): any {
        const type = Lua.lua_getglobal(this.Main, name)
        return this.getValue(this.Main, -1, type)
    }

    public setGlobal(name: string, value: any): void {
        this.pushValue(this.Main, value)
        Lua.lua_setglobal(this.Main, name)
    }

    public callGlobal(name: string, ...args: any[]): any[] {
        const type = Lua.lua_getglobal(this.Main, name);
        if (type !== LuaType.Function) {
            throw new Error(`A function of type '${type}' was pushed, expected is ${LuaType.Function}`)
        }

        for (const arg of args) {
            this.pushValue(this.Main, arg);
        }

        Lua.clua_call(this.Main, args.length, LUA_MULTRET);

        const returns = Lua.lua_gettop(this.Main)
        const returnValues = [];

        for (let i = 1; i <= returns; i++) {
            returnValues.push(this.getValue(this.Main, i));
        }

        return returnValues;
    }

    public mountFile(path: string, content: string | ArrayBufferView): void {
        const fileSep = path.lastIndexOf('/')
        const file = path.substr(fileSep + 1)
        const body = path.substr(0, path.length - file.length - 1)

        if (body.length > 0) {
            const parts = body.split('/').reverse()
            let parent = ''

            while (parts.length) {
                const part = parts.pop()
                if (!part) continue

                const current = parent + '/' + part
                try {
                    Lua.module.FS.mkdir(current)
                } catch (e) {
                    // ignore EEXIST
                }

                parent = current
            }
        }

        Lua.module.FS.writeFile(path, content)
    }

    public close(): void {
        Lua.lua_close(this.Main)
        this.Main = undefined
    }

    private pushValue(L: LuaState, value: any, done: AnyObject = {}): void {
        const type = typeof value

        if (done[value]) {
            Lua.lua_pushvalue(L, done[value])
            return
        }

        if (type === 'undefined' || value === null) {
            Lua.lua_pushnil(L)
        } else if (type === 'number') {
            if (Number.isInteger(value)) {
                Lua.lua_pushinteger(L, value)
            } else {
                Lua.lua_pushnumber(L, value)
            }
        } else if (type === 'string') {
            Lua.lua_pushstring(L, value)
        } else if (type === 'boolean') {
            Lua.lua_pushboolean(L, value)
        } else if (type === 'object') {
            if (value instanceof Thread) {
                Lua.lua_pushthread(value)
            } else {
                Lua.clua_newtable(L)
    
                const table = Lua.lua_gettop(L)
                done[value] = table
    
                if (Array.isArray(value)) {
                    for (let i = 0; i < value.length; i++) {
                        this.pushValue(L, i + 1)
                        this.pushValue(L, value[i], done)
    
                        Lua.lua_settable(L, table)
                    }
                } else {
                    for (const key in value) {
                        this.pushValue(L, key)
                        this.pushValue(L, value[key], done)
    
                        Lua.lua_settable(L, table)
                    }
                }
            }
        } else if (type === 'function') {
            const pointer = Lua.module.addFunction((calledL: LuaState) => {
                const argsQuantity = Lua.lua_gettop(calledL)
                const args = []
                for (let i = 1; i <= argsQuantity; i++) {
                    args.push(this.getValue(calledL, i))
                }

                const result = value(...args)
                this.pushValue(calledL, result)

                return 1
            }, 'ii');
            Lua.clua_pushcfunction(L, pointer)
        } else {
            throw new Error(`The type '${type}' is not supported by Lua`)
        }
    }

    private getValue(L: LuaState, idx: number, type: LuaType = undefined, done: { [key: number]: AnyObject } = {}): any {
        type = type || Lua.lua_type(L, idx)

        switch (type) {
            case LuaType.None:
                return undefined
            case LuaType.Nil:
                return null
            case LuaType.Number:
                return Lua.clua_tonumber(L, idx)
            case LuaType.String:
                return Lua.clua_tostring(L, idx)
            case LuaType.Boolean:
                return Lua.lua_toboolean(L, idx)
            case LuaType.Table:
                return this.getTableValue(L, idx, done)
            case LuaType.Function:
                Lua.lua_pushvalue(L, idx)
                const func = Lua.luaL_ref(L, LUA_REGISTRYINDEX)

                const jsFunc = (...args: any[]) => {
                    if (this.isClosed) {
                        console.warn('Tried to call a function after closing lua state')
                        return
                    }

                    const type = Lua.lua_rawgeti(L, LUA_REGISTRYINDEX, func)
                    if (type !== LuaType.Function) {
                        throw new Error(`A function of type '${type}' was pushed, expected is ${LuaType.Function}`)
                    }

                    for (const arg of args) {
                        this.pushValue(L, arg)
                    }

                    Lua.clua_call(L, args.length, 1)
                    return this.getValue(L, -1)
                }

                this.functionRegistry?.register(jsFunc, func)

                return jsFunc
            case LuaType.Thread:
                const value = Lua.lua_tothread(L, idx)
                return new Thread(value)
            default:
                throw new Error(`The type '${type}' returned is not supported on JS`)
        }
    }

    private getTableValue(L: LuaState, idx: number, done: { [key: number]: AnyObject } = {}) {
        let table: AnyObject = {}

        const pointer = Lua.lua_topointer(L, idx);
        if (done[pointer]) {
            return done[pointer]
        }

        done[pointer] = table

        Lua.lua_pushnil(L)

        if (idx < 0) {
            idx--
        }

        while (Lua.lua_next(L, idx)) {
            const keyType = Lua.lua_type(L, -2)
            const key = this.getValue(L, -2, keyType, done)

            const valueType = Lua.lua_type(L, -1)
            const value = this.getValue(L, -1, valueType, done)

            table[key] = value

            Lua.clua_pop(L, 1)
        }

        return table
    }

    private get isClosed(): boolean {
        return !this.Main
    }

    public dumpStack(L: LuaState = this.Main) {
        console.log(`Dumping Lua stack`)
        Lua.clua_dump_stack(L)
    }
}