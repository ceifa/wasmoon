import initWasmModule from './lua/glue.js';
import './lua/glue.wasm';

interface LuaEmscriptenModule extends EmscriptenModule {
    cwrap: typeof cwrap;
    addFunction: typeof addFunction;
}

export default class LuaWasm {
    protected static module: LuaEmscriptenModule;

    constructor() {
        LuaWasm.throwIfUninitialized();
    }

    public static async ensureInitialization(customName?: string) {
        if (!LuaWasm.module) {
            LuaWasm.module = <LuaEmscriptenModule>await initWasmModule({
                print: console.log,
                printErr: console.error,
                locateFile: (path: string, scriptDirectory: string) => {
                    return customName || scriptDirectory + path
                }
            });
            LuaWasm.bindWrappedFunctions();
        }
    }

    protected static throwIfUninitialized() {
        if (!LuaWasm.module) {
            throw new Error(`Module is not initialized, did you forget to call 'ensureInitialization'?`);
        }
    }

    protected static luaL_newstate: () => LuaState;
    protected static luaL_openlibs: (L: LuaState) => void;
    protected static clua_dostring: (L: LuaState, code: string) => LuaReturn;
    protected static lua_getglobal: (L: LuaState, name: string) => LuaType;
    protected static clua_tonumber: (L: LuaState, idx: number) => number;
    protected static clua_tostring: (L: LuaState, idx: number) => string;
    protected static lua_toboolean: (L: LuaState, idx: number) => boolean;
    protected static lua_gettable: (L: LuaState, idx: number) => number;
    protected static lua_next: (L: LuaState, idx: number) => boolean;
    protected static lua_type: (L: LuaState, idx: number) => LuaType;
    protected static clua_pop: (L: LuaState, idx: number) => void;
    protected static clua_dump_stack: (L: LuaState) => void;
    protected static lua_topointer: (L: LuaState, idx: number) => number;
    protected static lua_pushnil: (L: LuaState) => void;
    protected static lua_pushvalue: (L: LuaState, idx: number) => void;
    protected static lua_pushinteger: (L: LuaState, integer: number) => void;
    protected static lua_pushnumber: (L: LuaState, number: number) => void;
    protected static lua_pushstring: (L: LuaState, string: string) => void;
    protected static lua_pushboolean: (L: LuaState, boolean: boolean) => void;
    protected static lua_setglobal: (L: LuaState, name: string) => void;
    protected static clua_newtable: (L: LuaState) => void;
    protected static lua_gettop: (L: LuaState) => number;
    protected static lua_settable: (L: LuaState, idx: number) => void;
    protected static lua_callk: (L: LuaState, nargs: number, nresults: number, ctx: number, func: number) => void;
    protected static clua_pushcfunction: (L: LuaState, cfunction: number) => void;
    protected static lua_close: (L: LuaState) => void;

    private static bindWrappedFunctions() {
        LuaWasm.luaL_newstate = LuaWasm.module.cwrap('luaL_newstate', 'number', []);
        LuaWasm.luaL_openlibs = LuaWasm.module.cwrap('luaL_openlibs', undefined, ['number']);
        LuaWasm.clua_dostring = LuaWasm.module.cwrap('clua_dostring', 'number', ['number', 'string']);
        LuaWasm.lua_getglobal = LuaWasm.module.cwrap('lua_getglobal', 'number', ['number', 'string']);
        LuaWasm.clua_tonumber = LuaWasm.module.cwrap('clua_tonumber', 'number', ['number', 'number'])
        LuaWasm.clua_tostring = LuaWasm.module.cwrap('clua_tostring', 'string', ['number', 'number'])
        LuaWasm.lua_toboolean = LuaWasm.module.cwrap('lua_toboolean', 'boolean', ['number', 'number'])
        LuaWasm.lua_gettable = LuaWasm.module.cwrap('lua_gettable', 'number', ['number', 'number'])
        LuaWasm.lua_next = LuaWasm.module.cwrap('lua_next', 'boolean', ['number', 'number'])
        LuaWasm.lua_type = LuaWasm.module.cwrap('lua_type', 'number', ['number', 'number'])
        LuaWasm.clua_pop = LuaWasm.module.cwrap('clua_pop', undefined, ['number', 'number'])
        LuaWasm.clua_dump_stack = LuaWasm.module.cwrap('clua_dump_stack', undefined, ['number'])
        LuaWasm.lua_topointer = LuaWasm.module.cwrap('lua_topointer', 'number', ['number', 'number']);
        LuaWasm.lua_pushnil = LuaWasm.module.cwrap('lua_pushnil', undefined, ['number'])
        LuaWasm.lua_pushvalue = LuaWasm.module.cwrap('lua_pushvalue', undefined, ['number', 'number'])
        LuaWasm.lua_pushinteger = LuaWasm.module.cwrap('lua_pushinteger', undefined, ['number', 'number']);
        LuaWasm.lua_pushnumber = LuaWasm.module.cwrap('lua_pushnumber', undefined, ['number', 'number']);
        LuaWasm.lua_pushstring = LuaWasm.module.cwrap('lua_pushstring', undefined, ['number', 'string']);
        LuaWasm.lua_pushboolean = LuaWasm.module.cwrap('lua_pushboolean', undefined, ['number', 'boolean']);
        LuaWasm.lua_setglobal = LuaWasm.module.cwrap('lua_setglobal', undefined, ['number', 'string'])
        LuaWasm.clua_newtable = LuaWasm.module.cwrap('clua_newtable', undefined, ['number'])
        LuaWasm.lua_gettop = LuaWasm.module.cwrap('lua_gettop', 'number', ['number'])
        LuaWasm.lua_settable = LuaWasm.module.cwrap('lua_settable', undefined, ['number', 'number'])
        LuaWasm.lua_callk = LuaWasm.module.cwrap('lua_callk', undefined, ['number', 'number', 'number', 'number', 'number'])
        LuaWasm.clua_pushcfunction = LuaWasm.module.cwrap('clua_pushcfunction', undefined, ['number', 'number'])
        LuaWasm.lua_close = LuaWasm.module.cwrap('lua_close', undefined, ['number']);
    }
}
