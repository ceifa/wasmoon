import LuaWasm from './luawasm'
import {
    Thread, AnyObject, LuaReturn, LuaState, LuaType, LUA_MULTRET, LUA_REGISTRYINDEX
} from './types'

export class Lua extends LuaWasm {
    // Backward compatibility
    private readonly functionRegistry = typeof FinalizationRegistry !== 'undefined' ?
        new FinalizationRegistry(func => {
            Lua.luaL_unref(this.L, LUA_REGISTRYINDEX, func)
        }) : undefined

    private L: LuaState

    constructor() {
        super()
        this.L = Lua.luaL_newstate()

        if (!this.L) {
            throw new Error("Lua state could not be created (probably due to lack of memory)")
        }
    }

    public registerStandardLib() {
        Lua.luaL_openlibs(this.L)
    }

    public doString(script: string): any {
        const result = Lua.clua_dostring(this.L, script)
        if (result !== LuaReturn.Ok) {
            const error = Lua.clua_tostring(this.L, -1)
            throw new Error('Lua error: ' + error)
        }

        return this.getValue(1)
    }

    public getGlobal(name: string): any {
        const type = Lua.lua_getglobal(this.L, name)
        return this.getValue(-1, type)
    }

    public setGlobal(name: string, value: any): void {
        this.pushValue(value)
        Lua.lua_setglobal(this.L, name)
    }

    public callGlobal(name: string, ...args: any[]): any[] {
        const type = Lua.lua_getglobal(this.L, name);
        if (type !== LuaType.Function) {
            throw new Error(`A function of type '${type}' was pushed, expected is ${LuaType.Function}`)
        }

        for (const arg of args) {
            this.pushValue(arg);
        }

        Lua.clua_call(this.L, args.length, LUA_MULTRET);

        const returns = Lua.lua_gettop(this.L)
        const returnValues = [];

        for (let i = 1; i <= returns; i++) {
            returnValues.push(this.getValue(i));
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
        Lua.lua_close(this.L)
        this.L = undefined
    }

    private pushValue(value: any, done: AnyObject = {}): void {
        const type = typeof value

        if (done[value]) {
            Lua.lua_pushvalue(this.L, done[value])
            return
        }

        if (type === 'undefined' || value === null) {
            Lua.lua_pushnil(this.L)
        } else if (type === 'number') {
            if (Number.isInteger(value)) {
                Lua.lua_pushinteger(this.L, value)
            } else {
                Lua.lua_pushnumber(this.L, value)
            }
        } else if (type === 'string') {
            Lua.lua_pushstring(this.L, value)
        } else if (type === 'boolean') {
            Lua.lua_pushboolean(this.L, value)
        } else if (type === 'object') {
            if (value instanceof Thread) {
                Lua.lua_pushthread(value)
            } else {
                Lua.clua_newtable(this.L)
    
                const table = Lua.lua_gettop(this.L)
                done[value] = table
    
                if (Array.isArray(value)) {
                    for (let i = 0; i < value.length; i++) {
                        this.pushValue(i + 1)
                        this.pushValue(value[i], done)
    
                        Lua.lua_settable(this.L, table)
                    }
                } else {
                    for (const key in value) {
                        this.pushValue(key)
                        this.pushValue(value[key], done)
    
                        Lua.lua_settable(this.L, table)
                    }
                }
            }
        } else if (type === 'function') {
            const pointer = Lua.module.addFunction((L: LuaState) => {
                const argsQuantity = Lua.lua_gettop(L)
                const args = []
                for (let i = 1; i <= argsQuantity; i++) {
                    args.push(this.getValue(i))
                }

                const result = value(...args)
                this.pushValue(result)

                return 1
            }, 'ii');
            Lua.clua_pushcfunction(this.L, pointer)
        } else {
            throw new Error(`The type '${type}' is not supported by Lua`)
        }
    }

    private getValue(idx: number, type: LuaType = undefined, done: { [key: number]: AnyObject } = {}): any {
        type = type || Lua.lua_type(this.L, idx)

        switch (type) {
            case LuaType.None:
                return undefined
            case LuaType.Nil:
                return null
            case LuaType.Number:
                return Lua.clua_tonumber(this.L, idx)
            case LuaType.String:
                return Lua.clua_tostring(this.L, idx)
            case LuaType.Boolean:
                return Lua.lua_toboolean(this.L, idx)
            case LuaType.Table:
                return this.getTableValue(idx, done)
            case LuaType.Function:
                Lua.lua_pushvalue(this.L, idx)
                const func = Lua.luaL_ref(this.L, LUA_REGISTRYINDEX)

                const jsFunc = (...args: any[]) => {
                    if (!this.L) {
                        console.warn('Tried to call a function after closing lua state')
                        return
                    }

                    const type = Lua.lua_rawgeti(this.L, LUA_REGISTRYINDEX, func)
                    if (type !== LuaType.Function) {
                        throw new Error(`A function of type '${type}' was pushed, expected is ${LuaType.Function}`)
                    }

                    for (const arg of args) {
                        this.pushValue(arg)
                    }

                    Lua.clua_call(this.L, args.length, 1)
                    return this.getValue(-1)
                }

                this.functionRegistry?.register(jsFunc, func)

                return jsFunc
            case LuaType.Thread:
                const value = Lua.lua_tothread(this.L, idx)
                return new Thread(value)
            default:
                throw new Error(`The type '${type}' returned is not supported on JS`)
        }
    }

    private getTableValue(idx: number, done: { [key: number]: AnyObject } = {}) {
        let table: AnyObject = {}

        const pointer = Lua.lua_topointer(this.L, idx);
        if (done[pointer]) {
            return done[pointer]
        }

        done[pointer] = table

        Lua.lua_pushnil(this.L)

        if (idx < 0) {
            idx--
        }

        while (Lua.lua_next(this.L, idx)) {
            const keyType = Lua.lua_type(this.L, -2)
            const key = this.getValue(-2, keyType, done)

            const valueType = Lua.lua_type(this.L, -1)
            const value = this.getValue(-1, valueType, done)

            table[key] = value

            Lua.clua_pop(this.L, 1)
        }

        return table
    }

    public dumpStack(...logs: any[]) {
        console.log(`Dumping Lua stack`, logs)
        Lua.clua_dump_stack(this.L)
    }
}

export { Thread }