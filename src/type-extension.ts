import { BaseDecorationOptions, Decoration } from './decoration'
import Global from './global'
import Thread from './thread'
import { LuaType, PointerSize } from './types'

export default abstract class LuaTypeExtension<T, K extends BaseDecorationOptions = BaseDecorationOptions> {
    // Type name, for metatables and lookups.
    public readonly name: string
    protected thread: Global

    public constructor(t: Global, n: string) {
        this.thread = t
        this.name = n
    }

    public isType(_t: Thread, _i: number, t: LuaType, n?: string): boolean {
        return t === LuaType.Userdata && n === this.name
    }

    public abstract close(): void

    // A base implementation that assumes user data serialisation
    public getValue(t: Thread, i: number, _u?: unknown): T {
        const refUserdata = t.lua.luaL_testudata(t.address, i, this.name)
        if (!refUserdata) {
            throw new Error(`data does not have the expected metatable: ${this.name}`)
        }
        const referencePointer = t.lua._emscripten.getValue(refUserdata, '*')
        return t.lua.getRef(referencePointer)
    }

    // Return false if type not matched, otherwise true. This base method does not
    // check the type. That must be done by the class extending this.
    public pushValue(t: Thread, d: Decoration<T, K>, _u?: unknown): boolean {
        const { target } = d

        const pointer = t.lua.ref(target)
        // 4 = size of pointer in wasm.
        const userDataPointer = t.lua.lua_newuserdatauv(t.address, PointerSize, 0)
        t.lua._emscripten.setValue(userDataPointer, pointer, '*')

        if (LuaType.Nil === t.lua.luaL_getmetatable(t.address, this.name)) {
            // Pop the pushed nil value and the user data. Don't need to unref because it's
            // already associated with the user data pointer.
            t.pop(2)
            throw new Error(`metatable not found: ${this.name}`)
        }

        // Set as the metatable for the userdata.
        // -1 is the metatable, -2 is the user data.
        t.lua.lua_setmetatable(t.address, -2)

        return true
    }
}
