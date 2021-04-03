import { LuaMetatables, LuaReturn, LuaState } from './types'
import Thread from './thread'
import type LuaWasm from './luawasm'

interface LuaMemoryStats {
    memoryUsed: number
    memoryMax?: number
}

export default class Global extends Thread {
    public readonly functionGcPointer: number
    public readonly jsRefGcPointer: number
    private memoryStats: LuaMemoryStats
    private allocatorFunctionPointer: number

    public constructor(cmodule: LuaWasm) {
        const memoryStats: LuaMemoryStats = { memoryUsed: 0 }
        const allocatorFunctionPointer = cmodule.module.addFunction((_userData: number, pointer: number, oldSize: number, newSize: number):
            | number
            | null => {
            if (newSize === 0 && pointer) {
                cmodule.module._free(pointer)
                return null
            }

            const increasing = Boolean(pointer) || newSize > oldSize
            const endMemoryDelta = pointer ? newSize - oldSize : newSize
            const endMemory = memoryStats.memoryUsed + endMemoryDelta

            if (increasing && memoryStats.memoryMax && endMemory > memoryStats.memoryMax) {
                return null
            }

            const reallocated = cmodule.module._realloc(pointer, newSize)
            if (reallocated) {
                memoryStats.memoryUsed = endMemory
            }
            return reallocated
        }, 'iiiii')

        const address = cmodule.lua_newstate(allocatorFunctionPointer, null)
        super(cmodule, address)

        this.memoryStats = memoryStats
        this.allocatorFunctionPointer = allocatorFunctionPointer

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
        if (cmodule.luaL_newmetatable(address, LuaMetatables.FunctionReference)) {
            cmodule.lua_pushstring(address, '__gc')
            cmodule.lua_pushcclosure(address, this.functionGcPointer, 0)
            cmodule.lua_settable(address, -3)

            cmodule.lua_pushstring(address, '__metatable')
            cmodule.lua_pushstring(address, 'protected metatable')
            cmodule.lua_settable(address, -3)
        }
        // Pop the metatable from the stack.
        cmodule.lua_pop(address, 1)

        this.jsRefGcPointer = cmodule.module.addFunction((calledL: LuaState) => {
            // Throws a lua error which does a jump if it does not match.
            const userDataPointer = cmodule.luaL_checkudata(calledL, 1, LuaMetatables.JsReference)
            const referencePointer = cmodule.module.getValue(userDataPointer, '*')
            cmodule.unref(referencePointer)

            return LuaReturn.Ok
        }, 'ii')

        // Creates metatable if it doesn't exist, always pushes it onto the stack.
        if (cmodule.luaL_newmetatable(address, LuaMetatables.JsReference)) {
            cmodule.lua_pushstring(address, '__gc')
            cmodule.lua_pushcclosure(address, this.jsRefGcPointer, 0)
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
        this.cmodule.module.removeFunction(this.jsRefGcPointer)
        this.cmodule.module.removeFunction(this.allocatorFunctionPointer)
    }

    public isClosed(): boolean {
        return !this.address || this.closed
    }

    public getMemoryUsed(): number {
        return this.memoryStats.memoryUsed
    }

    public getMemoryMax(): number | undefined {
        return this.memoryStats.memoryMax
    }

    public setMemoryMax(max: number | undefined): void {
        this.memoryStats.memoryMax = max
    }
}
