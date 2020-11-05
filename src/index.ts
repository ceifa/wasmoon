const initialize: EmscriptenModuleFactory = require("./glue");

interface LuaEmscriptenModule extends EmscriptenModule {
    cwrap: typeof cwrap;
}

const enum LuaType {
    None = -1,
    Nil = 0,
    Boolean = 1,
    LightUserData = 2,
    Number = 3,
    String = 4,
    Table = 5,
    Function = 6,
    UserData = 7,
    Thread = 8
}

class LuaWasm {
    protected static luaL_newstate: () => number;
    protected static luaL_openlibs: (L: number) => void;
    protected static clua_dostring: (L: number, code: string) => number;
    protected static lua_getglobal: (L: number, name: string) => number;
    protected static clua_tonumber: (L: number, idx: number) => number;
    protected static lua_close: (L: number) => void;

    protected static module: LuaEmscriptenModule;

    constructor() {
        LuaWasm.throwIfUninitialized();
    }

    public static async ensureInitialization() {
        if (!this.module) {
            // TODO: Why I cannot use 'this' here????
            LuaWasm.module = <LuaEmscriptenModule>await initialize({
                print: console.log,
                printErr: console.error
            });
            LuaWasm.bindWrappedFunctions();
        }
    }

    protected static throwIfUninitialized() {
        if (!this.module) {
            throw new Error(`Module is not initialized, have you forgot to call 'ensureInitialization'?`);
        }
    }

    private static bindWrappedFunctions() {
        this.luaL_newstate = this.module.cwrap('luaL_newstate', 'number', []);
        this.luaL_openlibs = this.module.cwrap('luaL_openlibs', undefined, ['number']);
        this.clua_dostring = this.module.cwrap('clua_dostring', 'number', ['number', 'string']);
        this.lua_getglobal = this.module.cwrap('lua_getglobal', 'number', ['number', 'string']);
        this.clua_tonumber = this.module.cwrap('clua_tonumber', 'number', ['number', 'number'])
        this.lua_close = this.module.cwrap('lua_close', undefined, ['number']);
    }
}

export class LuaState extends LuaWasm {
    // Pointer to the internal lua state object
    private L: number;

    constructor() {
        super();
        this.L = LuaState.luaL_newstate();
    }

    public registerStandardLib() {
        LuaState.luaL_openlibs(this.L);
    }

    public doString(script: string) {
        const result: number = LuaWasm.clua_dostring(this.L, script);
        if (result > 0) {
            // TODO: handle error?
        }
    }

    public getGlobal(name: string): any {
        const type: LuaType = LuaState.lua_getglobal(this.L, name);

        switch (type) {
            case LuaType.Nil:
                return null;
            case LuaType.Number:
                return LuaState.clua_tonumber(this.L, 1);
            // TODO: Support more return types
        }
    }

    public setGlobal(name: string, value: any) {
        // TODO: Write
    }

    public close(): void {
        LuaState.lua_close(this.L);
    }
}
