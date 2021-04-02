import { LuaMetatables, LuaReturn, LuaState } from './types'
import Thread from './thread'
import type LuaWasm from './luawasm'

export default class Global extends Thread {
    public readonly functionGcPointer: number

    constructor(cmodule: LuaWasm, address: LuaState) {
        super(cmodule, address)

        this.functionGcPointer = cmodule.module.addFunction((calledL: LuaState) => {
            // Throws a lua error which does a jump if it does not match.
            const userDataPointer = cmodule.luaL_checkudata(calledL, 1, LuaMetatables.FunctionReference)
            const functionPointer = cmodule.module.getValue(userDataPointer, '*')
            // Safe to do without a reference count because each time a function is pushed it creates a new and unique
            // anonymous function.
            cmodule.module.removeFunction(functionPointer)

            return LuaReturn.Ok
        }, 'ii')

        // Creates metatable if it doesn't exist, always pushes it onto the stack.
        if (0 !== cmodule.luaL_newmetatable(address, LuaMetatables.FunctionReference)) {
            cmodule.lua_pushstring(address, '__gc')
            cmodule.lua_pushcclosure(address, this.functionGcPointer, 0)
            cmodule.lua_settable(address, -3)

            cmodule.lua_pushstring(address, '__metatable')
            cmodule.lua_pushstring(address, 'protected metatable')
            cmodule.lua_settable(address, -3)
        }
        // Pop the metatable from the stack.
        cmodule.lua_pop(address, 1)
    }

    public close(): void {
        if (this.closed) {
            return
        }
        this.closed = true
        // Do this before removing the gc to force
        this.cmodule.lua_close(this.address)
        this.cmodule.module.removeFunction(this.functionGcPointer)
    }

    public isClosed(): boolean {
        return !this.address || this.closed
    }
}
