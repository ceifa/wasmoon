import { LuaReturn } from './types'
import Global from './global'
import type LuaWasm from './luawasm'

export default class Lua {
    public global: Global

    constructor(private cmodule: LuaWasm, openStandardLibs: boolean) {
        this.global = new Global(this.cmodule, this.cmodule.luaL_newstate())

        if (this.global.isClosed()) {
            throw new Error('Lua state could not be created (probably due to lack of memory)')
        }

        if (openStandardLibs) {
            this.cmodule.luaL_openlibs(this.global.address)
        }
    }

    public doString(script: string): any {
        this.global.loadString(script)
        return this.callByteCode()
    }

    public doFile(filename: string): any {
        this.global.loadFile(filename)
        return this.callByteCode()
    }

    private callByteCode(): any {
        const result = this.cmodule.lua_pcallk(this.global.address, 0, 1, 0, 0, undefined)

        if (result !== LuaReturn.Ok) {
            const error = this.cmodule.lua_tolstring(this.global.address, -1, undefined)
            throw new Error(`Lua error(${result}): ${error}`)
        }

        return this.global.getValue(1)
    }
}
