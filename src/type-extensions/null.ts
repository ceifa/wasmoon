import { Decoration } from '../decoration'
import type LuaState from '../state'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import { LUA_REGISTRYINDEX } from '../types'

class NullTypeExtension extends TypeExtension<unknown> {
    private gcPointer: number
    private nullReference: number

    public constructor(state: LuaState) {
        super(state, 'js_null')

        this.gcPointer = this.createGcFunction()

        if (state.lua.luaL_newmetatable(state.address, this.name)) {
            const metatableIndex = state.lua.lua_gettop(state.address)

            // Mark it as uneditable
            state.lua.lua_pushstring(state.address, 'protected metatable')
            state.lua.lua_setfield(state.address, metatableIndex, '__metatable')

            // Add the gc function
            state.lua.lua_pushcclosure(state.address, this.gcPointer, 0)
            state.lua.lua_setfield(state.address, metatableIndex, '__gc')

            // Add an __index method that returns nothing.
            state.pushValue(() => null)
            state.lua.lua_setfield(state.address, metatableIndex, '__index')

            state.pushValue(() => 'null')
            state.lua.lua_setfield(state.address, metatableIndex, '__tostring')

            state.pushValue((self: unknown, other: unknown) => self === other)
            state.lua.lua_setfield(state.address, metatableIndex, '__eq')
        }
        // Pop the metatable from the stack.
        state.lua.lua_pop(state.address, 1)

        // Create a new table, this is unique and will be the "null" value by attaching the
        // metatable created above. The first argument is the target, the second options.
        super.pushValue(state, new Decoration<unknown>({}, {}))

        // Lua code is free to reassign the `null` global, so marshalling anchors the sentinel in
        // the registry instead of looking it up by name.
        state.lua.lua_pushvalue(state.address, -1)
        this.nullReference = state.lua.luaL_ref(state.address, LUA_REGISTRYINDEX)

        state.lua.lua_setglobal(state.address, 'null')
    }

    public getValue(thread: Thread, index: number): null {
        const refUserData = thread.lua.luaL_testudata(thread.address, index, this.name)
        if (!refUserData) {
            throw new Error(`data does not have the expected metatable: ${this.name}`)
        }
        return null
    }

    public pushValue(thread: Thread, decoration: Decoration<unknown>): boolean {
        if (decoration.target !== null) {
            return false
        }
        thread.lua.lua_rawgeti(thread.address, LUA_REGISTRYINDEX, BigInt(this.nullReference))
        return true
    }

    public close(): void {
        this.state.lua._emscripten.removeFunction(this.gcPointer)
    }
}

export default function createTypeExtension(state: LuaState): TypeExtension<unknown> {
    return new NullTypeExtension(state)
}
