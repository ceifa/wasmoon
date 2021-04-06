import { LuaEngineOptions } from './types'
import Global from './global'
import Thread from './thread'
import createErrorType from './type-extensions/error'
import createPromiseType from './type-extensions/promise'
import type LuaWasm from './luawasm'

const defaultOptions: LuaEngineOptions = {
    openStandardLibs: true,
    injectObjects: false,
}

export default class Lua {
    public global: Global

    public constructor(private cmodule: LuaWasm, userOptions?: Partial<LuaEngineOptions>) {
        this.global = new Global(this.cmodule)

        const options: LuaEngineOptions = {
            ...defaultOptions,
            ...(userOptions || {}),
        }

        this.global.registerTypeExtension(createErrorType(this.global, options.injectObjects))
        this.global.registerTypeExtension(createPromiseType(this.global, options.injectObjects))

        if (this.global.isClosed()) {
            throw new Error('Lua state could not be created (probably due to lack of memory)')
        }

        if (options.openStandardLibs) {
            this.cmodule.luaL_openlibs(this.global.address)
        }
    }

    public doString(script: string): Promise<any> {
        return this.callByteCode((thread) => thread.loadString(script))
    }

    public doFile(filename: string): Promise<any> {
        return this.callByteCode((thread) => thread.loadFile(filename))
    }

    private async callByteCode(loader: (thread: Thread) => void): Promise<any> {
        const thread = this.global.newThread()
        const threadIndex = this.global.getTop()
        try {
            loader(thread)
            const result = await thread.run(0)
            if (result.length > 0) {
                this.cmodule.lua_xmove(thread.address, this.global.address, result.length)
            }
            return result[0]
        } finally {
            // Pop the read on success or failure
            this.global.remove(threadIndex)
        }
    }
}
