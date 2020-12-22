import Global from './global'
import { LuaReturn } from './types'
import LuaWasm from './luawasm'

export default class Lua {
    public global: Global

    constructor(private module: LuaWasm, openStandardLibs: boolean) {
        this.global = new Global(this.module, this.module.luaL_newstate())

        if (this.global.isClosed()) {
            throw new Error("Lua state could not be created (probably due to lack of memory)")
        }

        if (openStandardLibs) {
            this.module.luaL_openlibs(this.global.address)
        }
    }

    public doString(script: string): any {
        return this.callByteCode(() => this.module.luaL_loadstring(this.global.address, script))
    }

    public doFile(filename: string): any {
        return this.callByteCode(() => this.module.luaL_loadfilex(this.global.address, filename, undefined))
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
                    this.module.module.FS.mkdir(current)
                } catch (e) {
                    // ignore EEXIST
                }

                parent = current
            }
        }

        this.module.module.FS.writeFile(path, content)
    }

    private callByteCode(loader: () => LuaReturn) {
        const result = loader() ||
            this.module.lua_pcallk(this.global.address, 0, 1, 0, 0, undefined)

        if (result !== LuaReturn.Ok) {
            const error = this.module.lua_tolstring(this.global.address, -1, undefined)
            throw new Error(`Lua error(${result}): ${error}`)
        }

        return this.global.getValue(1)
    }
}