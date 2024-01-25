import { LuaLibraries, LuaType } from './types'
import LuaTypeExtension from './type-extension'
import Thread from './thread'
import type LuaWasm from './luawasm'

interface LuaMemoryStats {
    memoryUsed: number
    memoryMax?: number
}

/**
 * Represents the global state of the Lua engine.
 * @class
 * @export
 */
export default class Global extends Thread {
    private memoryStats: LuaMemoryStats | undefined
    private allocatorFunctionPointer: number | undefined

    /**
     * Constructs a new Global instance.
     * @constructor
     * @param {LuaWasm} cmodule - The Lua WebAssembly module.
     * @param {boolean} shouldTraceAllocations - Whether to trace memory allocations.
     */
    public constructor(cmodule: LuaWasm, shouldTraceAllocations: boolean) {
        if (shouldTraceAllocations) {
            const memoryStats: LuaMemoryStats = { memoryUsed: 0 }
            const allocatorFunctionPointer = cmodule.module.addFunction(
                (_userData: number, pointer: number, oldSize: number, newSize: number): number => {
                    if (newSize === 0) {
                        if (pointer) {
                            memoryStats.memoryUsed -= oldSize
                            cmodule.module._free(pointer)
                        }
                        return 0
                    }

                    const endMemoryDelta = pointer ? newSize - oldSize : newSize
                    const endMemory = memoryStats.memoryUsed + endMemoryDelta

                    if (newSize > oldSize && memoryStats.memoryMax && endMemory > memoryStats.memoryMax) {
                        return 0
                    }

                    const reallocated = cmodule.module._realloc(pointer, newSize)
                    if (reallocated) {
                        memoryStats.memoryUsed = endMemory
                    }
                    return reallocated
                },
                'iiiii',
            )

            const address = cmodule.lua_newstate(allocatorFunctionPointer, null)
            if (!address) {
                cmodule.module.removeFunction(allocatorFunctionPointer)
                throw new Error('lua_newstate returned a null pointer')
            }
            super(cmodule, [], address)

            this.memoryStats = memoryStats
            this.allocatorFunctionPointer = allocatorFunctionPointer
        } else {
            super(cmodule, [], cmodule.luaL_newstate())
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
            this.lua.module.removeFunction(this.allocatorFunctionPointer)
        }

        for (const wrapper of this.typeExtensions) {
            wrapper.extension.close()
        }
    }

    // To allow library users to specify custom types
    // Higher is more important and will be evaluated first.
    /**
     * Registers a type extension for Lua objects.
     *  Higher priority is more important and will be evaluated first.
     * @param {number} priority - Priority of the type extension.
     * @param {LuaTypeExtension<unknown>} extension - The type extension to register.
     */
    public registerTypeExtension(priority: number, extension: LuaTypeExtension<unknown>): void {
        this.typeExtensions.push({ extension, priority })
        this.typeExtensions.sort((a, b) => b.priority - a.priority)
    }

    /**
     * Loads a default Lua library.
     * @param {LuaLibraries} library - The Lua library to load.
     */
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
        this.lua.lua_setglobal(this.address, library)
    }

    /**
     * Retrieves the value of a global variable.
     * @param {string} name - The name of the global variable.
     * @returns {any} - The value of the global variable.
     */
    public get(name: string): any {
        const type = this.lua.lua_getglobal(this.address, name)
        const value = this.getValue(-1, type)
        this.pop()
        return value
    }

    /**
     * Sets the value of a global variable.
     * @param {string} name - The name of the global variable.
     * @param {unknown} value - The value to set for the global variable.
     */
    public set(name: string, value: unknown): void {
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

    /**
     * Gets the amount of memory used by the Lua engine. Can only be used if the state was created with the `traceAllocations` option set to true.
     * @returns {number} - The amount of memory used in bytes.
     */
    public getMemoryUsed(): number {
        return this.getMemoryStatsRef().memoryUsed
    }

    /**
     * Gets the maximum memory allowed for the Lua engine. Can only be used if the state was created with the `traceAllocations` option set to true.
     * @returns {number | undefined} - The maximum memory allowed in bytes, or undefined if not set.
     */
    public getMemoryMax(): number | undefined {
        return this.getMemoryStatsRef().memoryMax
    }

    /**
     * Sets the maximum memory allowed for the Lua engine. Can only be used if the state was created with the `traceAllocations` option set to true.
     * @param {number | undefined} max - The maximum memory allowed in bytes, or undefined for unlimited.
     */
    public setMemoryMax(max: number | undefined): void {
        this.getMemoryStatsRef().memoryMax = max
    }

    private getMemoryStatsRef(): LuaMemoryStats {
        if (!this.memoryStats) {
            throw new Error('Memory allocations is not being traced, please build engine with { traceAllocations: true }')
        }

        return this.memoryStats
    }
}
