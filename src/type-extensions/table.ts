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

    public isType(_thread: Thread, _index: number, type: LuaType): boolean {
        return type === LuaType.Table
    }

    public getValue(thread: Thread, index: number, cache?: LuaGetCache): TableType {
        // This is a map of Lua pointers to JS objects.
        const seenMap: LuaGetCache = cache ?? new Map()
        const pointer = thread.module.lua_topointer(thread.address, index)

        let table = seenMap.get(pointer) as TableType | undefined
        if (!table) {
            table = thread.module.emscripten._wasmoon_isarray(thread.address, index) ? [] : {}

            // Registered before the values are read, so a table that contains itself resolves to
            // this same object rather than to a second copy of it.
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
            thread.module.lua_rawgeti(thread.address, LUA_REGISTRYINDEX, existingReference)
            return true
        }

        try {
            const tableIndex = thread.getTop() + 1

            // A for..in loop would also copy inherited members.
            const keys = Array.isArray(target) ? undefined : Object.keys(target)
            thread.module.lua_createtable(thread.address, keys ? 0 : (target as any[]).length, keys?.length ?? 0)
            thread.module.lua_pushvalue(thread.address, tableIndex)
            seenMap.set(target, thread.module.luaL_ref(thread.address, LUA_REGISTRYINDEX))

            if (!keys) {
                const array = target as any[]
                for (let i = 0; i < array.length; i++) {
                    thread.pushValue(array[i], seenMap)
                    // Raw, so the table being built cannot be observed through metamethods.
                    thread.module.lua_rawseti(thread.address, tableIndex, i + 1)
                }
            } else {
                for (const key of keys) {
                    thread.module.lua_pushstring(thread.address, key)
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

    private readTableValues(thread: Thread, index: number, seenMap: LuaGetCache, table: TableType): void {
        const isArray = Array.isArray(table)
        // lua_next leaves each key and value in the same two slots, so the indexes are resolved
        // once here rather than by a lua_absindex per entry.
        const keyIndex = thread.getTop() + 1
        const valueIndex = keyIndex + 1

        thread.module.lua_pushnil(thread.address)
        while (thread.module.lua_next(thread.address, index)) {
            if (isArray) {
                // An array takes its order from the walk, so its keys are never converted.
                table.push(thread.getValue(valueIndex, undefined, seenMap))
            } else {
                table[this.readKey(thread, keyIndex)] = thread.getValue(valueIndex, undefined, seenMap)
            }

            thread.pop()
        }
    }

    /**
     * A key as the JS property name, which is how Lua would print it. A string, the usual case, is
     * read in place: luaL_tolstring would look for a __tostring on it, push a copy and need a pop.
     */
    private readKey(thread: Thread, index: number): string {
        if (thread.module.lua_type(thread.address, index) === LuaType.String) {
            return thread.module.lua_tolstring(thread.address, index, null)
        }
        return thread.indexToString(index)
    }
}

export default function createTypeExtension(state: LuaState): TypeExtension<TableType> {
    return new TableTypeExtension(state)
}
