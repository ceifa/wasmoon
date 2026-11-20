import type LuaState from '../state'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import { type LuaGetCache, type LuaPushCache, LuaType, type LuaTypeDefinition } from '../types'

/** A type defined through `LuaState.defineType`. */
export default class DefinedTypeExtension<T = unknown> extends TypeExtension<T> {
    private readonly match: (value: unknown) => boolean
    private readonly toLua: ((value: T) => unknown) | undefined
    private readonly fromLua: ((value: any) => T) | undefined
    private readonly boxed: boolean

    public constructor(state: LuaState, definition: LuaTypeDefinition<T>) {
        if (typeof definition.name !== 'string' || !definition.name) {
            throw new TypeError('defineType needs a name')
        }
        if (typeof definition.match !== 'function') {
            throw new TypeError('defineType needs a match function')
        }
        super(state, definition.name)
        this.match = definition.match
        this.toLua = definition.toLua
        this.fromLua = definition.fromLua
        // A type that converts lives in Lua as a table, with no reference to release.
        this.boxed = !this.toLua && !this.fromLua

        this.defineMetatable(definition.metatable, { exclusive: true, boxed: this.boxed })
    }

    /** Whether Lua tables whose metatable is merely named after this type are read through it. */
    public get readsByName(): boolean {
        return this.fromLua !== undefined
    }

    /** False when the value is not of this type, which leaves it to whatever is consulted next. */
    public push(thread: Thread, value: unknown, cache?: LuaPushCache): boolean {
        if (!this.match(value)) {
            return false
        }
        if (this.boxed) {
            this.pushReference(thread, value)
            return true
        }
        if (!this.toLua) {
            return false
        }

        const converted = this.toLua(value as T)
        // Declining a value this way cannot recurse, where pushing it again would.
        if (converted === value) {
            return false
        }
        thread.pushValue(converted, cache)

        // Only a table can be told apart later. One that already has a metatable keeps it.
        const { module, address: L } = thread
        if (module.lua_type(L, -1) === LuaType.Table) {
            if (module.lua_getmetatable(L, -1)) {
                module.lua_pop(L, 1)
            } else {
                module.luaL_setmetatable(L, this.name)
            }
        }
        return true
    }

    public override getValue(thread: Thread, index: number, cache?: LuaGetCache): T {
        if (this.boxed) {
            return super.getValue(thread, index)
        }
        const value = this.state.marshaller.tables.getValue(thread, index, cache)
        return this.fromLua ? this.fromLua(value) : (value as T)
    }
}
