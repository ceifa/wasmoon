import { LuaWasm } from './luawasm'

export class Lua extends LuaWasm {
    private L: LuaState;

    constructor() {
        super();
        this.L = Lua.luaL_newstate();
    }

    public registerStandardLib() {
        Lua.luaL_openlibs(this.L);
    }

    public doString(script: string) {
        const result = Lua.clua_dostring(this.L, script);
        if (result !== LuaReturn.Ok) {
            const error = Lua.clua_tostring(this.L, -1)
            throw new Error('Lua error: ' + error)
        }
    }

    public getGlobal(name: string): any {
        const type = Lua.lua_getglobal(this.L, name);
        return this.getValue(1, type);
    }

    public setGlobal(name: string, value: any): void {
        this.pushValue(value);
        Lua.lua_setglobal(this.L, name);
    }

    public close(): void {
        Lua.lua_close(this.L);
    }

    private pushValue(value: any, done: AnyObject = {}): void {
        const type = typeof value;

        if (done[value]) {
            Lua.lua_pushvalue(this.L, done[value])
            return;
        }

        if (type === 'undefined' || value === null) {
            Lua.lua_pushnil(this.L);
        } else if (type === 'number') {
            if (Number.isInteger(value)) {
                Lua.lua_pushinteger(this.L, value);
            } else {
                Lua.lua_pushnumber(this.L, value);
            }
        } else if (type === 'string') {
            Lua.lua_pushstring(this.L, value);
        } else if (type === 'boolean') {
            Lua.lua_pushboolean(this.L, value);
        } else if (type === 'object') {
            Lua.clua_newtable(this.L);

            const table = Lua.lua_gettop(this.L);
            done[value] = table;

            for (const key in value) {
                this.pushValue(key);
                this.pushValue(value[key], done);

                Lua.lua_settable(this.L, table);
            }
        } else if (type === 'function') {
            const pointer = Lua.module.addFunction((L: LuaState) => {
                const argsQuantity = Lua.lua_gettop(L);
                const args = [];
                for (let i = 1; i <= argsQuantity; i++) {
                    args.push(this.getValue(i));
                }

                const result = value(...args);
                this.pushValue(result);

                return 1;
            }, 'ii');
            Lua.clua_pushcfunction(this.L, pointer);
        } else {
            throw new Error(`The type '${type}' is not supported by Lua`);
        }
    }

    private getValue(idx: number, type: LuaType = undefined, done: { [key: number]: AnyObject } = {}): any {
        type = type || Lua.lua_type(this.L, idx);

        switch (type) {
            case LuaType.Nil:
                return null;
            case LuaType.Number:
                return Lua.clua_tonumber(this.L, idx);
            case LuaType.String:
                return Lua.clua_tostring(this.L, idx);
            case LuaType.Boolean:
                return Lua.lua_toboolean(this.L, idx);
            case LuaType.Table:
                return this.getTableValue(idx, done);
            case LuaType.Function:
                const func = Lua.lua_topointer(this.L, idx);
                return (...args: any[]) => {
                    for (const arg of args) {
                        this.pushValue(arg);
                    }

                    Lua.lua_callk(this.L, args.length, 1, 0, func);
                    return this.getValue(-1)
                }
            default:
                throw new Error(`The type '${type}' returned is not supported on JS`)
        }
    }

    private getTableValue(idx: number, done: { [key: number]: AnyObject } = {}) {
        let table: AnyObject = {};

        const pointer = Lua.lua_topointer(this.L, idx);
        if (done[pointer]) {
            return done[pointer];
        }

        done[pointer] = table;

        Lua.lua_pushnil(this.L);
        while (Lua.lua_next(this.L, idx)) {
            const keyType = Lua.lua_type(this.L, idx + 1);
            const key = this.getValue(idx + 1, keyType, done);

            const valueType = Lua.lua_type(this.L, idx + 2);
            const value = this.getValue(idx + 2, valueType, done);

            table[key] = value;

            Lua.clua_pop(this.L, 1);
        }

        return table;
    }

    private dumpStack(...logs: any[]) {
        console.log(`Dumping Lua stack`, logs)
        Lua.clua_dump_stack(this.L);
    }
}
