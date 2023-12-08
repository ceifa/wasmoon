import { Decoration } from '../decoration'
import { LuaReturn, LuaState } from '../types'
import Global from '../global'
import Thread from '../thread'
import TypeExtension from '../type-extension'

class NullTypeExtension extends TypeExtension<unknown> {
    private gcPointer: number

    public constructor(thread: Global) {
        super(thread, 'js_null')

        this.gcPointer = thread.lua.module.addFunction((functionStateAddress: LuaState) => {
            // Throws a lua error which does a jump if it does not match.
            const userDataPointer = thread.lua.luaL_checkudata(functionStateAddress, 1, this.name)
            const referencePointer = thread.lua.module.getValue(userDataPointer, '*')
            thread.lua.unref(referencePointer)

            return LuaReturn.Ok
        }, 'ii')

        if (thread.lua.luaL_newmetatable(thread.address, this.name)) {
            const metatableIndex = thread.lua.lua_gettop(thread.address)

            // Mark it as uneditable
            thread.lua.lua_pushstring(thread.address, 'protected metatable')
            thread.lua.lua_setfield(thread.address, metatableIndex, '__metatable')

            // Add the gc function
            thread.lua.lua_pushcclosure(thread.address, this.gcPointer, 0)
            thread.lua.lua_setfield(thread.address, metatableIndex, '__gc')

            // Add an __index method that returns nothing.
            thread.pushValue(() => null)
            thread.lua.lua_setfield(thread.address, metatableIndex, '__index')

            thread.pushValue(() => 'null')
            thread.lua.lua_setfield(thread.address, metatableIndex, '__tostring')

            thread.pushValue((self: unknown, other: unknown) => self === other)
            thread.lua.lua_setfield(thread.address, metatableIndex, '__eq')
        }
        // Pop the metatable from the stack.
        thread.lua.lua_pop(thread.address, 1)

        // Create a new table, this is unique and will be the "null" value by attaching the
        // metatable created above. The first argument is the target, the second options.
        super.pushValue(thread, new Decoration<unknown>({}, {}))
        // Put it into the global field named null.
        thread.lua.lua_setglobal(thread.address, 'null')
    }

    public getValue(thread: Thread, index: number): null {
        const refUserData = thread.lua.luaL_testudata(thread.address, index, this.name)
        if (!refUserData) {
            throw new Error(`data does not have the expected metatable: ${this.name}`)
        }
        return null
    }

    // any because LuaDecoration is not exported from the Lua lib.
    public pushValue(thread: Thread, decoration: any): boolean {
        if (decoration?.target !== null) {
            return false
        }
        // Rather than pushing a new value, get the global "null" onto the stack.
        thread.lua.lua_getglobal(thread.address, 'null')
        return true
    }

    public close(): void {
        this.thread.lua.module.removeFunction(this.gcPointer)
    }
}

export default function createTypeExtension(thread: Global): TypeExtension<null> {
    return new NullTypeExtension(thread)
}
