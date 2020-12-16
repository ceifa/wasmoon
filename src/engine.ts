import Global from './global'
import LuaWasm from './luawasm'
import { LuaReturn } from './types'

export default class Lua {
    public global: Global

    constructor(openStandardLibs: boolean = true) {
        if (!LuaWasm.module) {
            throw new Error(`Module is not initialized, did you forget to call 'ensureInitialization'?`)
        }

        this.global = new Global(LuaWasm.luaL_newstate())

        if (this.global.isClosed()) {
            throw new Error("Lua state could not be created (probably due to lack of memory)")
        }

        if (openStandardLibs) {
            LuaWasm.luaL_openlibs(this.global.address)
        }
    }

    public doString(script: string): any {
        const result = LuaWasm.luaL_loadstring(this.global.address, script) ||
            LuaWasm.lua_pcallk(this.global.address, 0, 1, 0, 0, undefined)

        if (result !== LuaReturn.Ok) {
            const error = LuaWasm.lua_tolstring(this.global.address, -1, undefined)
            throw new Error('Lua error: ' + error)
        }

        return this.global.getValue(1)
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
                    LuaWasm.module.FS.mkdir(current)
                } catch (e) {
                    // ignore EEXIST
                }

                parent = current
            }
        }

        LuaWasm.module.FS.writeFile(path, content)
    }

    public static ensureInitialization =  LuaWasm.ensureInitialization
}