import { Decoration } from '../decoration'
import type LuaState from '../state'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import { LuaType } from '../types'

class UserdataTypeExtension extends TypeExtension<any> {
    private readonly gcPointer: number

    public constructor(state: LuaState) {
        super(state, 'js_userdata')

        this.gcPointer = this.createGcFunction()

        if (state.module.luaL_newmetatable(state.address, this.name)) {
            const metatableIndex = state.module.lua_gettop(state.address)

            // Mark it as uneditable
            state.module.lua_pushstring(state.address, 'protected metatable')
            state.module.lua_setfield(state.address, metatableIndex, '__metatable')

            // Add the gc function
            state.module.lua_pushcclosure(state.address, this.gcPointer, 0)
            state.module.lua_setfield(state.address, metatableIndex, '__gc')
        }

        // Pop the metatable from the stack.
        state.module.lua_pop(state.address, 1)
    }

    public isType(_thread: Thread, _index: number, type: LuaType, name?: string): boolean {
        return type === LuaType.Userdata && name === this.name
    }

    public getValue(thread: Thread, index: number): any {
        const refUserdata = thread.module.lua_touserdata(thread.address, index)
        const referencePointer = thread.module.readPointer(refUserdata)
        return thread.module.getRef(referencePointer)
    }

    public pushValue(thread: Thread, decoratedValue: Decoration<unknown>): boolean {
        if (decoratedValue.options.as !== 'userdata') {
            return false
        }

        return super.pushValue(thread, decoratedValue)
    }

    public close(): void {
        this.state.module.removeFunction(this.gcPointer)
    }
}

export default function createTypeExtension(state: LuaState): TypeExtension<any> {
    return new UserdataTypeExtension(state)
}
