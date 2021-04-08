import { BaseDecorationOptions, Decoration } from '../decoration'
import { LuaReturn, LuaState, LuaType } from '../types'
import Thread from '../thread'
import TypeExtension from '../type-extension'

export interface UserDataDecorationOptions extends BaseDecorationOptions {
    reference?: boolean
}

export function decorateUserData(target: any, options: UserDataDecorationOptions): Decoration<any, UserDataDecorationOptions> {
    return new Decoration<any, UserDataDecorationOptions>(target, options)
}

class UserdataTypeExtension extends TypeExtension<any, UserDataDecorationOptions> {
    public constructor(thread: Thread) {
        super(thread, 'js_userdata')

        this.gcPointer = thread.cmodule.module.addFunction((functionStateAddress: LuaState) => {
            const userDataPointer = thread.cmodule.lua_touserdata(functionStateAddress, -1)
            const referencePointer = thread.cmodule.module.getValue(userDataPointer, '*')
            thread.cmodule.unref(referencePointer)

            return LuaReturn.Ok
        }, 'ii')

        if (thread.cmodule.luaL_newmetatable(thread.address, this.name)) {
            const metatableIndex = thread.cmodule.lua_gettop(thread.address)

            // Mark it as uneditable
            thread.cmodule.lua_pushstring(thread.address, 'protected metatable')
            thread.cmodule.lua_setfield(thread.address, metatableIndex, '__metatable')

            // Add the gc function
            thread.cmodule.lua_pushcclosure(thread.address, this.gcPointer, 0)
            thread.cmodule.lua_setfield(thread.address, metatableIndex, '__gc')
        }

        // Pop the metatable from the stack.
        thread.cmodule.lua_pop(thread.address, 1)
    }

    public isType(_thread: Thread, _index: number, type: LuaType, name?: string): boolean {
        return type === LuaType.UserData && name === this.name
    }

    public getValue(thread: Thread, index: number): any {
        const refUserData = thread.cmodule.lua_touserdata(thread.address, index)
        const referencePointer = thread.cmodule.module.getValue(refUserData, '*')
        return thread.cmodule.getRef(referencePointer)
    }

    public pushValue(thread: Thread, decoratedValue: Decoration<any, UserDataDecorationOptions>): boolean {
        const { options } = decoratedValue
        if (!options?.reference) {
            return false
        }

        return super.pushValue(thread, decoratedValue)
    }

    public close(): void {
        this.thread.cmodule.module.removeFunction(this.gcPointer!)
    }
}

export default function createTypeExtension(thread: Thread): TypeExtension<Error> {
    return new UserdataTypeExtension(thread)
}
