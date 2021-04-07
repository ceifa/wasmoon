import Thread from '../thread'
import TypeExtension from '../type-extension'
import { LuaReturn, LuaState, LuaType } from '../types';

class UserdataTypeExtension extends TypeExtension<any> {
    private readonly gcPointer: number;

    public constructor(thread: Thread) {
        super(thread, 'userdata')

        this.gcPointer = thread.cmodule.module.addFunction((functionStateAddress: LuaState) => {
            // Throws a lua error which does a jump if it does not match.
            const userDataPointer = thread.cmodule.luaL_checkudata(functionStateAddress, 1, this.name)
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

    public isType(_thread: Thread, _index: number, type: LuaType): boolean {
        return type === LuaType.UserData
    }

    public getValue(thread: Thread, index: number): any {
        const refUserData = thread.cmodule.lua_touserdata(thread.address, index)
        const referencePointer = thread.cmodule.module.getValue(refUserData, '*')
        return thread.cmodule.getRef(referencePointer)
    }

    public pushValue(thread: Thread, value: unknown, decorations: Record<string, any>): boolean {
        if (!decorations?.reference) {
            return false
        }

        return super.pushValue(thread, value, decorations)
    }

    public close(): void {
        this.thread.cmodule.module.removeFunction(this.gcPointer)
    }
}

export default function createTypeExtension(thread: Thread): TypeExtension<Error> {
    return new UserdataTypeExtension(thread)
}
