import Global from './global'
import MultiReturn from './multireturn'
import Thread from './thread'
import type LuaWasm from './luawasm'

export default class Lua {
    public global: Global

    public constructor(private cmodule: LuaWasm, openStandardLibs: boolean) {
        this.global = new Global(this.cmodule)

        if (this.global.isClosed()) {
            throw new Error('Lua state could not be created (probably due to lack of memory)')
        }

        if (openStandardLibs) {
            this.cmodule.luaL_openlibs(this.global.address)
        }
    }

    public doString(script: string): Promise<MultiReturn> {
        return this.callByteCode((thread) => thread.loadString(script))
    }

    public doFile(filename: string): Promise<MultiReturn> {
        return this.callByteCode((thread) => thread.loadFile(filename))
    }

    private async callByteCode(loader: (thread: Thread) => void): Promise<MultiReturn> {
        const thread = this.global.newThread()
        const threadIndex = this.global.getTop()
        try {
            loader(thread)
            const result = await thread.run(0)
            if (result.resultCount > 0) {
                this.cmodule.lua_xmove(thread.address, this.global.address, result.resultCount)
            }
            return this.global.getValues(result.resultCount)
        } finally {
            // Pop the read on success or failure
            this.global.remove(threadIndex)
        }
    }
}
