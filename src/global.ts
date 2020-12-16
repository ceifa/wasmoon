import Thread from "./thread"
import LuaWasm from "./luawasm"
import { LuaState } from "./types"

export default class Global extends Thread {    
    constructor(module: LuaWasm, address: LuaState) {
        super(module, address, undefined)
    }

    public close() {
        this.closed = true
        this.module.lua_close(this.address)
    }

    public isClosed() {
        return !this.address || this.closed
    }
}