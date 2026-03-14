import type LuaModule from './module'
import Thread from './thread'
import LuaTypeExtension from './type-extension'
import { LuaLibraries, LuaType } from './types'

interface LuaMemoryStats {
    memoryUsed: number
    memoryMax?: number
}

/**
 * Represents the global state of the Lua engine.
 */
export default class Global extends Thread {
    private memoryStats: LuaMemoryStats | undefined
    private allocatorFunctionPointer: number | undefined

    /**
     * Constructs a new Global instance.
     * @param cmodule - The Lua module.
     * @param shouldTraceAllocations - Whether to trace memory allocations.
     */
    public constructor(m: LuaModule, t: boolean) {
        if (t) {
            const memoryStats: LuaMemoryStats = { memoryUsed: 0 }
            const allocatorFunctionPointer = m._emscripten.addFunction(
                (_userData: number, pointer: number, oldSize: number, newSize: number): number => {
                    if (newSize === 0) {
                        if (pointer) {
                            memoryStats.memoryUsed -= oldSize
                            m._emscripten._free(pointer)
                        }
                        return 0
                    }

                    const endMemoryDelta = pointer ? newSize - oldSize : newSize
                    const endMemory = memoryStats.memoryUsed + endMemoryDelta

                    if (
                        newSize > oldSize &&
                        memoryStats.memoryMax &&
                        endMemory > memoryStats.memoryMax
                    ) {
                        return 0
                    }

                    const reallocated = m._emscripten._realloc(pointer, newSize)
                    if (reallocated) {
                        memoryStats.memoryUsed = endMemory
                    }
                    return reallocated
                },
                'iiiii',
            )

            const address = m.lua_newstate(
                allocatorFunctionPointer,
                null,
                ((Date.now() >>> 0) ^ Math.floor(Math.random() * 0x100000000)) >>> 0,
            )
            if (!address) {
                m._emscripten.removeFunction(allocatorFunctionPointer)
                throw new Error('lua_newstate returned a null pointer')
            }
            super(m, [], address)

            this.memoryStats = memoryStats
            this.allocatorFunctionPointer = allocatorFunctionPointer
        } else {
            super(m, [], m.luaL_newstate())
        }

        if (this.isClosed()) {
            throw new Error('Global state could not be created (probably due to lack of memory)')
        }
    }

    /**
     * Closes the global state of the Lua engine.
     */
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

        if (this.allocatorFunctionPointer) {
            this.lua._emscripten.removeFunction(this.allocatorFunctionPointer)
        }

        for (const wrapper of this.typeExtensions) {
            wrapper.extension.close()
        }
    }

    /**
     * Registers a type extension for Lua objects.
     * Higher priority is more important and will be evaluated first.
     * Allows library users to specify custom types
     * @param priority - Priority of the type extension.
     * @param extension - The type extension to register.
     */
    public registerTypeExtension(p: number, e: LuaTypeExtension<unknown>): void {
        this.typeExtensions.push({ extension: e, priority: p })
        this.typeExtensions.sort((a, b) => b.priority - a.priority)
    }

    /**
     * Loads a default Lua library.
     * @param library - The Lua library to load.
     */
    public loadLibrary(l: LuaLibraries): void {
        switch (l) {
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
                this.lua.luaopen_utf8(this.address)
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
        this.lua.lua_setglobal(this.address, l)
    }

    /**
     * Retrieves the value of a global variable.
     * @param name - The name of the global variable.
     * @returns - The value of the global variable.
     */
    public get(n: string): any {
        const type = this.lua.lua_getglobal(this.address, n)
        const value = this.getValue(-1, type)
        this.pop()
        return value
    }

    /**
     * Sets the value of a global variable.
     * @param name - The name of the global variable.
     * @param value - The value to set for the global variable.
     */
    public set(n: string, v: unknown): void {
        this.pushValue(v)
        this.lua.lua_setglobal(this.address, n)
    }

    public getTable(n: string, c: (i: number) => void): void {
        const startStackTop = this.getTop()
        const type = this.lua.lua_getglobal(this.address, n)
        try {
            if (type !== LuaType.Table) {
                throw new TypeError(
                    `Unexpected type in ${n}. Expected ${LuaType[LuaType.Table]}. Got ${LuaType[type]}.`,
                )
            }
            c(startStackTop + 1)
        } finally {
            // +1 for the table
            if (this.getTop() !== startStackTop + 1) {
                console.warn(
                    `getTable: expected stack size ${startStackTop + 1} got ${this.getTop()}`,
                )
            }
            this.setTop(startStackTop)
        }
    }

    /**
     * Gets the amount of memory used by the Lua engine. Can only be used if the state was created with the `traceAllocations` option set to true.
     * @returns - The amount of memory used in bytes.
     */
    public getMemoryUsed(): number {
        return this.getMemoryStatsRef().memoryUsed
    }

    /**
     * Gets the maximum memory allowed for the Lua engine. Can only be used if the state was created with the `traceAllocations` option set to true.
     * @returns - The maximum memory allowed in bytes, or undefined if not set.
     */
    public getMemoryMax(): number | undefined {
        return this.getMemoryStatsRef().memoryMax
    }

    /**
     * Sets the maximum memory allowed for the Lua engine. Can only be used if the state was created with the `traceAllocations` option set to true.
     * @param max - The maximum memory allowed in bytes, or undefined for unlimited.
     */
    public setMemoryMax(m: number | undefined): void {
        this.getMemoryStatsRef().memoryMax = m
    }

    private getMemoryStatsRef(): LuaMemoryStats {
        if (!this.memoryStats) {
            throw new Error(
                'Memory allocations is not being traced, please build engine with { traceAllocations: true }',
            )
        }

        return this.memoryStats
    }
}
