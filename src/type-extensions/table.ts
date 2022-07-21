import { Decoration } from '../decoration'
import { LUA_REGISTRYINDEX, LuaType } from '../types'
import Global from '../global'
import Thread from '../thread'
import TypeExtension from '../type-extension'

export interface CallableTable {
    [key: string]: any
    (...args: any[]): any
}
export type TableType = Record<any, any> | any[] | CallableTable

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
        const seenMap: Map<number, Record<string, string> | CallableTable> =
            userdata || new Map<number, Record<string, string> | CallableTable>()
        const pointer = thread.lua.lua_topointer(thread.address, index)

        let table = seenMap.get(pointer)
        if (!table) {
            const __call = thread.lua.luaL_getmetafield(thread.address, index, '__call')
            if (__call === LuaType.Function) {
            } else {
                const __index = thread.lua.luaL_getmetafield(thread.address, index, '__index')
                const __newindex = thread.lua.luaL_getmetafield(thread.address, index, '__newindex')
                if (__index === LuaType.Function || __newindex === LuaType.Function) {
                } else {
                    table = {}
                }
            }

            seenMap.set(pointer, table)
            this.tableToObject(thread, index, seenMap, table)
        }

        const keys = Object.keys(table)

        // Only sequential tables will be considered as arrays
        const isSequential = keys.length > 0 && keys.every((key, index) => key === String(index + 1))
        return isSequential ? Object.values(table) : table
    }

    public pushValue(thread: Thread, { target }: Decoration<TableType>, userdata?: Map<any, number>): boolean {
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

    private tableToObject(
        thread: Thread,
        index: number,
        seenMap: Map<number, TableType>,
        table: Record<string, string> | CallableTable,
    ): void {
        thread.lua.lua_pushnil(thread.address)
        while (thread.lua.lua_next(thread.address, index)) {
            // JS only supports string keys in objects.
            const key = thread.lua.luaL_tolstring(thread.address, -2, null)
            thread.pop()
            const value = thread.getValue(-1, undefined, seenMap)

            table[key] = value

            thread.pop()
        }
    }
}

export default function createTypeExtension(thread: Global): TypeExtension<any> {
    return new TableTypeExtension(thread)
}
