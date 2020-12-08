import Thread from "./thread"
import LuaWasm from "./luawasm"
import { LuaState } from "./types"

export default class Global extends Thread {    
    constructor(address: LuaState) {
        super(address, undefined)
    }

    public close() {
        this.closed = true
        LuaWasm.lua_close(this.address)
    }

    public isClosed() {
        return !this.address || this.closed
    }
}