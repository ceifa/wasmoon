import { Decoration } from '../decoration'
import { LUA_REGISTRYINDEX, LuaType } from '../types'
import Global from '../global'
import Thread from '../thread'
import TypeExtension from '../type-extension'

export type TableType = Record<any, any> | any[]

class TableTypeExtension extends TypeExtension<TableType> {
    public constructor(thread: Global) {
        super(thread, 'js_table')
    }

    public close(): void {
        // Nothing to do
    }

    public isType(_thread: Thread, _index: number, type: LuaType): boolean {
        return type === LuaType.Table
    }

    public getValue(thread: Thread, index: number, userdata?: any): TableType {
        // This is a map of Lua pointers to JS objects.
        const seenMap: Map<number, TableType> = userdata || new Map()
        const pointer = thread.lua.lua_topointer(thread.address, index)

        let table = seenMap.get(pointer)
        if (!table) {
            const keys = this.readTableKeys(thread, index)

            const isSequential = keys.length > 0 && keys.every((key, index) => key === String(index + 1))
            table = isSequential ? [] : {}

            seenMap.set(pointer, table)
            this.readTableValues(thread, index, seenMap, table)
        }

        return table
    }

    public pushValue(thread: Thread, { target }: Decoration<TableType>, userdata?: Map<any, number>): boolean {
        if (typeof target !== 'object' || target === null) {
            return false
        }

        // This is a map of JS objects to luaL references.
        const seenMap = userdata || new Map<any, number>()
        const existingReference = seenMap.get(target)
        if (existingReference !== undefined) {
            thread.lua.lua_rawgeti(thread.address, LUA_REGISTRYINDEX, BigInt(existingReference))
            return true
        }

        try {
            const tableIndex = thread.getTop() + 1

            const createTable = (arrayCount: number, keyCount: number): void => {
                thread.lua.lua_createtable(thread.address, arrayCount, keyCount)
                const ref = thread.lua.luaL_ref(thread.address, LUA_REGISTRYINDEX)
                seenMap.set(target, ref)
                thread.lua.lua_rawgeti(thread.address, LUA_REGISTRYINDEX, BigInt(ref))
            }

            if (Array.isArray(target)) {
                createTable(target.length, 0)

                for (let i = 0; i < target.length; i++) {
                    thread.pushValue(i + 1, seenMap)
                    thread.pushValue(target[i], seenMap)

                    thread.lua.lua_settable(thread.address, tableIndex)
                }
            } else {
                createTable(0, Object.getOwnPropertyNames(target).length)

                for (const key in target) {
                    thread.pushValue(key, seenMap)
                    thread.pushValue((target as Record<string, any>)[key], seenMap)

                    thread.lua.lua_settable(thread.address, tableIndex)
                }
            }
        } finally {
            if (userdata === undefined) {
                for (const reference of seenMap.values()) {
                    thread.lua.luaL_unref(thread.address, LUA_REGISTRYINDEX, reference)
                }
            }
        }

        return true
    }

    private readTableKeys(thread: Thread, index: number): string[] {
        const keys = []

        thread.lua.lua_pushnil(thread.address)
        while (thread.lua.lua_next(thread.address, index)) {
            // JS only supports string keys in objects.
            const key = thread.indexToString(-2)
            keys.push(key)
            // Pop the value.
            thread.pop()
        }

        return keys
    }

    private readTableValues(thread: Thread, index: number, seenMap: Map<number, TableType>, table: TableType): void {
        const isArray = Array.isArray(table)

        thread.lua.lua_pushnil(thread.address)
        while (thread.lua.lua_next(thread.address, index)) {
            const key = thread.indexToString(-2)
            const value = thread.getValue(-1, undefined, seenMap)

            if (isArray) {
                table.push(value)
            } else {
                table[key] = value
            }

            thread.pop()
        }
    }
}

export default function createTypeExtension(thread: Global): TypeExtension<any> {
    return new TableTypeExtension(thread)
}
