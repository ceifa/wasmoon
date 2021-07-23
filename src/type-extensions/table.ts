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
        const seenMap: Map<number, TableType> = userdata || new Map<number, TableType>()
        const pointer = thread.lua.lua_topointer(thread.address, index)

        let table = seenMap.get(pointer)
        if (!table) {
            table = this.tableToObject(thread, index, seenMap)
            seenMap.set(pointer, table)
        }

        return table
    }

    public pushValue(thread: Thread, { target }: Decoration<TableType>, userdata?: any): boolean {
        if (typeof target !== 'object' || target === null) {
            return false
        }

        // This is a map of JS objects to luaL references.
        const seenMap = userdata || new Map<any, number>()
        const existingReference = seenMap.get(target)
        if (existingReference !== undefined) {
            thread.lua.lua_rawgeti(thread.address, LUA_REGISTRYINDEX, existingReference)
            return true
        }

        try {
            const tableIndex = thread.getTop() + 1

            const createTable = (arrayCount: number, keyCount: number): void => {
                thread.lua.lua_createtable(thread.address, arrayCount, keyCount)
                const ref = thread.lua.luaL_ref(thread.address, LUA_REGISTRYINDEX)
                seenMap.set(target, ref)
                thread.lua.lua_rawgeti(thread.address, LUA_REGISTRYINDEX, ref)
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

    private tableToObject(thread: Thread, index: number, seenMap: Map<number, TableType>): TableType {
        const table: TableType = {}
        let isArray = true
        let currentArrayIdx = 1

        thread.lua.lua_pushnil(thread.address)
        while (thread.lua.lua_next(thread.address, index)) {
            // JS only supports string keys in objects.
            const key = thread.lua.luaL_tolstring(thread.address, -2, null)
            thread.pop()
            const value = thread.getValue(-1, undefined, seenMap)

            table[key] = value

            // Only sequential tables will be considered as arrays
            if (isArray && key !== String(currentArrayIdx++)) {
                isArray = false
            }

            thread.pop()
        }

        // Empty tables should be considered as empty objects
        return isArray && currentArrayIdx > 1 ? Object.values(table) : table
    }
}

export default function createTypeExtension(thread: Global): TypeExtension<any> {
    return new TableTypeExtension(thread)
}
