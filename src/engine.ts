import { LuaEngineOptions } from './types'
import Global from './global'
import Thread from './thread'
import createErrorType from './type-extensions/error'
import createFunctionType from './type-extensions/function'
import createPromiseType from './type-extensions/promise'
import createTableType from './type-extensions/table'
import createUserdataType from './type-extensions/userdata'
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

        // Generic handlers - These may be required to be registered for additional types.
        this.global.registerTypeExtension(0, createTableType(this.global))
        this.global.registerTypeExtension(0, createFunctionType(this.global))
        // Specific type handlers. These depend on the above but should be evaluated first.
        this.global.registerTypeExtension(1, createErrorType(this.global, options.injectObjects))
        this.global.registerTypeExtension(1, createPromiseType(this.global, options.injectObjects))
        this.global.registerTypeExtension(2, createUserdataType(this.global))

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
