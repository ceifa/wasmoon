import { BaseDecorationOptions, Decoration } from './decoration'
import { LuaType, PointerSize } from './types'
import Thread from './thread'

export default abstract class LuaTypeExtension<T, K extends BaseDecorationOptions = BaseDecorationOptions> {
    // Type name, for metatables and lookups.
    public readonly name: string
    protected thread: Thread

    public constructor(thread: Thread, name: string) {
        this.thread = thread
        this.name = name
    }

    public isType(_thread: Thread, _index: number, type: LuaType, name?: string): boolean {
        return type === LuaType.UserData && name === this.name
    }

    public abstract close(): void

    // A base implementation that assumes user data serialisation
    public getValue(thread: Thread, index: number, _userdata?: any): T {
        const refUserData = thread.cmodule.luaL_testudata(thread.address, index, this.name)
        if (!refUserData) {
            throw new Error(`data does not have the expected metatable: ${this.name}`)
        }
        const referencePointer = thread.cmodule.module.getValue(refUserData, '*')
        return thread.cmodule.getRef(referencePointer)
    }

    // Return false if type not matched, otherwise true. This base method does not
    // check the type. That must be done by the class extending this.
    public pushValue(thread: Thread, decoratedValue: Decoration<T, K>, _userdata?: any): boolean {
        const { target } = decoratedValue

        const pointer = thread.cmodule.ref(target)
        // 4 = size of pointer in wasm.
        const userDataPointer = thread.cmodule.lua_newuserdatauv(thread.address, PointerSize, 0)
        thread.cmodule.module.setValue(userDataPointer, pointer, '*')

        if (LuaType.Nil === thread.cmodule.luaL_getmetatable(thread.address, this.name)) {
            // Pop the pushed nil value and the user data. Don't need to unref because it's
            // already associated with the user data pointer.
            thread.pop(2)
            throw new Error(`metatable not found: ${this.name}`)
        }

        // Set as the metatable for the userdata.
        // -1 is the metatable, -2 is the user data.
        thread.cmodule.lua_setmetatable(thread.address, -2)

        return true
    }
}
