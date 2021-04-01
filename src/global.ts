import Thread from "./thread"
import LuaWasm from "./luawasm"
import { LuaState } from "./types"

export default class Global extends Thread {    
    constructor(cmodule: LuaWasm, address: LuaState) {
        super(cmodule, address, undefined)
    }

    public close() {
        this.closed = true
        this.cmodule.lua_close(this.address)
    }

    public isClosed() {
        return !this.address || this.closed
    }
}