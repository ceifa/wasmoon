import type LuaState from '../state'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import { LUA_REGISTRYINDEX } from '../types'

class NullTypeExtension extends TypeExtension<null> {
    private nullReference: number

    public constructor(state: LuaState) {
        super(state, 'js_null')

        this.defineMetatable({
            __index: () => undefined,
            __tostring: () => 'null',
            __eq: (self: unknown, other: unknown) => self === other,
        })

        // A box like any other, around an object nothing else ever holds, is what makes the sentinel
        // unique: it carries the metatable above, so it reads back as null.
        this.pushReference(state, {})

        // Lua code is free to reassign the `null` global, so marshalling anchors the sentinel in
        // the registry instead of looking it up by name.
        state.module.lua_pushvalue(state.address, -1)
        this.nullReference = state.module.luaL_ref(state.address, LUA_REGISTRYINDEX)

        state.module.lua_setglobal(state.address, 'null')
    }

    public getValue(): null {
        return null
    }

    public push(thread: Thread): void {
        thread.module.lua_rawgeti(thread.address, LUA_REGISTRYINDEX, this.nullReference)
    }
}

export default function createTypeExtension(state: LuaState): NullTypeExtension {
    return new NullTypeExtension(state)
}
export type { NullTypeExtension }
