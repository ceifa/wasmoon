import { Decoration } from '../decoration'
import type LuaState from '../state'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import { LUA_REGISTRYINDEX, type LuaGetCache, type LuaPushCache, LuaType } from '../types'

export type TableType = Record<any, any> | any[]

class TableTypeExtension extends TypeExtension<TableType> {
    public constructor(state: LuaState) {
        super(state, 'js_table')
    }

    public close(): void {
        // Nothing to do
    }

    public isType(_thread: Thread, _index: number, type: LuaType): boolean {
        return type === LuaType.Table
    }

    public getValue(thread: Thread, index: number, cache?: LuaGetCache): TableType {
        // This is a map of Lua pointers to JS objects.
        const seenMap: LuaGetCache = cache ?? new Map()
        const pointer = thread.module.lua_topointer(thread.address, index)

        let table = seenMap.get(pointer) as TableType | undefined
        if (!table) {
            const keys = this.readTableKeys(thread, index)

            const isSequential = keys.length > 0 && keys.every((key, keyIndex) => key === String(keyIndex + 1))
            table = isSequential ? [] : {}

            seenMap.set(pointer, table)
            this.readTableValues(thread, index, seenMap, table)
        }

        return table
    }

    public pushValue(thread: Thread, { target }: Decoration<unknown>, cache?: LuaPushCache): boolean {
        if (typeof target !== 'object' || target === null) {
            return false
        }

        // This is a map of JS objects to luaL references.
        const seenMap: LuaPushCache = cache ?? new Map()
        const existingReference = seenMap.get(target)
        if (existingReference !== undefined) {
            thread.module.lua_rawgeti(thread.address, LUA_REGISTRYINDEX, BigInt(existingReference))
            return true
        }

        try {
            const tableIndex = thread.getTop() + 1

            const createTable = (arrayCount: number, keyCount: number): void => {
                thread.module.lua_createtable(thread.address, arrayCount, keyCount)
                const ref = thread.module.luaL_ref(thread.address, LUA_REGISTRYINDEX)
                seenMap.set(target, ref)
                thread.module.lua_rawgeti(thread.address, LUA_REGISTRYINDEX, BigInt(ref))
            }

            if (Array.isArray(target)) {
                createTable(target.length, 0)

                for (let i = 0; i < target.length; i++) {
                    thread.pushValue(target[i], seenMap)
                    // Raw, so the table being built cannot be observed through metamethods.
                    thread.module.lua_rawseti(thread.address, tableIndex, BigInt(i + 1))
                }
            } else {
                // A for..in loop would also walk the prototype chain and copy inherited members.
                const keys = Object.keys(target)
                createTable(0, keys.length)

                for (const key of keys) {
                    thread.pushValue(key, seenMap)
                    thread.pushValue((target as Record<string, any>)[key], seenMap)

                    thread.module.lua_rawset(thread.address, tableIndex)
                }
            }
        } finally {
            // Only the outermost push owns the anchors it created for the values below it.
            if (cache === undefined) {
                for (const reference of seenMap.values()) {
                    thread.module.luaL_unref(thread.address, LUA_REGISTRYINDEX, reference)
                }
            }
        }

        return true
    }

    private readTableKeys(thread: Thread, index: number): string[] {
        const keys = []

        thread.module.lua_pushnil(thread.address)
        while (thread.module.lua_next(thread.address, index)) {
            // JS only supports string keys in objects.
            const key = thread.indexToString(-2)
            keys.push(key)
            // Pop the value.
            thread.pop()
        }

        return keys
    }

    private readTableValues(thread: Thread, index: number, seenMap: LuaGetCache, table: TableType): void {
        const isArray = Array.isArray(table)

        thread.module.lua_pushnil(thread.address)
        while (thread.module.lua_next(thread.address, index)) {
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

export default function createTypeExtension(state: LuaState): TypeExtension<TableType> {
    return new TableTypeExtension(state)
}
