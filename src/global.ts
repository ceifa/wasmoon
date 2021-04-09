import LuaTypeExtension from './type-extension'
import Thread from './thread'
import type LuaWasm from './luawasm'

interface LuaMemoryStats {
    memoryUsed: number
    memoryMax?: number
}

export default class Global extends Thread {
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
        super(cmodule, [], address)

        this.memoryStats = memoryStats
        this.allocatorFunctionPointer = allocatorFunctionPointer
    }

    public close(): void {
        if (this.isClosed()) {
            return
        }

        super.close()

        // Do this before removing the gc to force.
        // Here rather than in the threads because you don't
        // actually close threads, just pop them. Only the top-level
        // lua state needs closing.
        this.cmodule.lua_close(this.address)

        this.cmodule.module.removeFunction(this.allocatorFunctionPointer)
        for (const wrapper of this.typeExtensions) {
            wrapper.extension.close()
        }
    }

    // To allow library users to specify custom types
    // Higher is more important and will be evaluated first.
    public registerTypeExtension(priority: number, extension: LuaTypeExtension<unknown>): void {
        this.typeExtensions.push({ extension, priority })
        this.typeExtensions.sort((a, b) => b.priority - a.priority)
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
