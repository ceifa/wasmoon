import { LuaLibraries, LuaType } from './types'
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
        this.lua.lua_close(this.address)

        this.lua.module.removeFunction(this.allocatorFunctionPointer)
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

    public loadLibrary(library: LuaLibraries): void {
        switch (library) {
            case LuaLibraries.Base:
                this.lua.luaopen_base(this.address)
                break
            case LuaLibraries.Coroutine:
                this.lua.luaopen_coroutine(this.address)
                break
            case LuaLibraries.Table:
                this.lua.luaopen_table(this.address)
                break
            case LuaLibraries.IO:
                this.lua.luaopen_io(this.address)
                break
            case LuaLibraries.OS:
                this.lua.luaopen_os(this.address)
                break
            case LuaLibraries.String:
                this.lua.luaopen_string(this.address)
                break
            case LuaLibraries.UTF8:
                this.lua.luaopen_string(this.address)
                break
            case LuaLibraries.Math:
                this.lua.luaopen_math(this.address)
                break
            case LuaLibraries.Debug:
                this.lua.luaopen_debug(this.address)
                break
            case LuaLibraries.Package:
                this.lua.luaopen_package(this.address)
                break
        }
    }

    public get(name: string): any {
        const type = this.lua.lua_getglobal(this.address, name)
        return this.getValue(-1, type)
    }

    public set(name: string, value: any): void {
        this.pushValue(value)
        this.lua.lua_setglobal(this.address, name)
    }

    public getTable(name: string, callback: (index: number) => void): void {
        const startStackTop = this.getTop()
        const type = this.lua.lua_getglobal(this.address, name)
        try {
            if (type !== LuaType.Table) {
                throw new TypeError(`Unexpected type in ${name}. Expected ${LuaType[LuaType.Table]}. Got ${LuaType[type]}.`)
            }
            callback(startStackTop + 1)
        } finally {
            // +1 for the table
            if (this.getTop() !== startStackTop + 1) {
                console.warn(`getTable: expected stack size ${startStackTop} got ${this.getTop()}`)
            }
            this.setTop(startStackTop)
        }
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
