import { Decoration } from '../decoration'
import { LUA_REGISTRYINDEX, LuaType } from '../types'
import Thread from '../thread'
import TypeExtension from '../type-extension'

export type TableType = Record<any, any> | any[]

class TableTypeExtension extends TypeExtension<TableType> {
    public constructor(thread: Thread) {
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
        const seenMap = userdata || new Map<number, Record<any, any>>()
        const pointer = thread.cmodule.lua_topointer(thread.address, index)

        const table = seenMap.get(pointer) || {}
        if (!seenMap.has(pointer)) {
            seenMap.set(pointer, table)
            this.getTable(thread, index, seenMap, table)
        }

        const tableLength = Object.keys(table).length
        // Specifically return an object if there's no way of telling whether
        // it's an array or object.
        if (tableLength === 0) {
            return table
        }

        let isArray = true
        const array: any[] = []
        for (let i = 1; i <= tableLength; i++) {
            const value = table[String(i)]
            if (value === undefined) {
                isArray = false
                break
            }
            array.push(value)
        }

        return isArray ? array : table
    }

    public pushValue(thread: Thread, decoratedValue: Decoration<TableType>, userdata?: any): boolean {
        const { target, options } = decoratedValue
        if (typeof target !== 'object' || target === null) {
            return false
        }

        // This is a map of JS objects to luaL references.
        const seenMap = userdata || new Map<any, number>()
        const existingReference = seenMap.get(target)
        if (existingReference !== undefined) {
            thread.cmodule.lua_rawgeti(thread.address, LUA_REGISTRYINDEX, existingReference)
            return true
        }

        try {
            const tableIndex = thread.getTop() + 1

            const createTable = (arrayCount: number, keyCount: number): void => {
                thread.cmodule.lua_createtable(thread.address, arrayCount, keyCount)
                const ref = thread.cmodule.luaL_ref(thread.address, LUA_REGISTRYINDEX)
                seenMap.set(target, ref)
                thread.cmodule.lua_rawgeti(thread.address, LUA_REGISTRYINDEX, ref)
            }

            if (Array.isArray(target)) {
                createTable(target.length, 0)

                for (let i = 0; i < target.length; i++) {
                    thread.pushValue(i + 1, seenMap)
                    thread.pushValue(target[i], seenMap)

                    thread.cmodule.lua_settable(thread.address, tableIndex)
                }
            } else {
                createTable(0, Object.getOwnPropertyNames(target).length)

                for (const key in target) {
                    thread.pushValue(key, seenMap)
                    thread.pushValue((target as Record<string, any>)[key], seenMap)

                    thread.cmodule.lua_settable(thread.address, tableIndex)
                }
            }

            if (typeof options.metatable === 'object') {
                thread.pushValue(options.metatable)
                thread.cmodule.lua_setmetatable(thread.address, tableIndex)
            }
        } finally {
            if (userdata === undefined) {
                for (const reference of seenMap.values()) {
                    thread.cmodule.luaL_unref(thread.address, LUA_REGISTRYINDEX, reference)
                }
            }
        }

        return true
    }

    private getTable(thread: Thread, index: number, seenMap: Map<number, Record<any, any>>, table: Record<any, any>): void {
        thread.cmodule.lua_pushnil(thread.address)

        while (thread.cmodule.lua_next(thread.address, index)) {
            // JS only supports string keys in objects.
            const key = thread.cmodule.luaL_tolstring(thread.address, -2, null)
            thread.pop()
            const value = thread.getValue(-1, undefined, seenMap)

            table[key] = value

            thread.pop()
        }
    }
}

export default function createTypeExtension(thread: Thread): TypeExtension<any> {
    return new TableTypeExtension(thread)
}
