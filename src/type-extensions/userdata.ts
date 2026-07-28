import { Decoration } from '../decoration'
import type LuaState from '../state'
import Thread from '../thread'
import TypeExtension from '../type-extension'
import { LuaReturn, LuaAddress, LuaType } from '../types'

class UserdataTypeExtension extends TypeExtension<any> {
    private readonly gcPointer: number

    public constructor(thread: LuaState) {
        super(thread, 'js_userdata')

        this.gcPointer = thread.lua._emscripten.addFunction((functionStateAddress: LuaAddress) => {
            // Throws a lua error which does a jump if it does not match.
            const userDataPointer = thread.lua.luaL_checkudata(functionStateAddress, 1, this.name)
            const referencePointer = thread.lua._emscripten.getValue(userDataPointer, '*')
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
        }

        // Pop the metatable from the stack.
        thread.lua.lua_pop(thread.address, 1)
    }

    public isType(_thread: Thread, _index: number, type: LuaType, name?: string): boolean {
        return type === LuaType.Userdata && name === this.name
    }

    public getValue(thread: Thread, index: number): any {
        const refUserdata = thread.lua.lua_touserdata(thread.address, index)
        const referencePointer = thread.lua._emscripten.getValue(refUserdata, '*')
        return thread.lua.getRef(referencePointer)
    }

    public pushValue(thread: Thread, decoratedValue: Decoration<any>): boolean {
        if (decoratedValue.options.as !== 'userdata') {
            return false
        }

        return super.pushValue(thread, decoratedValue)
    }

    public close(): void {
        this.thread.lua._emscripten.removeFunction(this.gcPointer)
    }
}

export default function createTypeExtension(thread: LuaState): TypeExtension<Error> {
    return new UserdataTypeExtension(thread)
}
