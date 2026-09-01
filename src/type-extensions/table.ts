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
            table = this.isSequential(thread, index) ? [] : {}

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

    /**
     * A table becomes a JS array only when `lua_next` walks exactly the integer keys 1..n in that
     * order, which is Lua's own notion of a sequence. The keys this pass looks at are read again
     * alongside the values, so it stops as soon as that is ruled out.
     */
    private isSequential(thread: Thread, index: number): boolean {
        const module = thread.module

        // A border of 0 means t[1] is nil, which settles every table read as an object -- the
        // common case -- with one call instead of starting a walk.
        if (module.lua_rawlen(thread.address, index) === 0n) {
            return false
        }

        let count = 0
        module.lua_pushnil(thread.address)
        while (module.lua_next(thread.address, index)) {
            // Compared as a number rather than through tostring, which would format the key in C
            // and decode it in JS for every element. A float key with an integral value is stored
            // as an integer, so this is the same test.
            if (module.lua_type(thread.address, -2) !== LuaType.Number || module.lua_tonumberx(thread.address, -2, null) !== count + 1) {
                // Pop the key and the value, since the walk is being abandoned part way.
                thread.pop(2)
                return false
            }
            count++
            // Pop the value.
            thread.pop()
        }

        // Non-empty, since a border above 0 means some element is present.
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
