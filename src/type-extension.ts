import type { Decoration } from './decoration'
import type LuaState from './state'
import type Thread from './thread'
import { type LuaAddress, type LuaGetCache, type LuaPushCache, LuaReturn, LuaType, PointerSize } from './types'

export default abstract class LuaTypeExtension<T> {
    // Type name, for metatables and lookups.
    public readonly name: string
    /** Owns this extension's metatable and function pointers, so its lifetime bounds theirs. */
    protected state: LuaState

    public constructor(state: LuaState, name: string) {
        this.state = state
        this.name = name
    }

    public isType(_thread: Thread, _index: number, type: LuaType, name?: string): boolean {
        return type === LuaType.Userdata && name === this.name
    }

    public abstract close(): void

    /**
     * The `__gc` handler every reference holding extension needs. The caller owns the returned
     * pointer and has to release it with `removeFunction` in {@link close}.
     */
    protected createGcFunction(): number {
        return this.state.module.emscripten.addFunction((calledL: LuaAddress) => {
            // Throws a lua error which does a jump if it does not match.
            const userDataPointer = this.state.module.luaL_checkudata(calledL, 1, this.name)
            const referencePointer = this.state.module.emscripten.getValue(userDataPointer, '*')
            this.state.module.unref(referencePointer)

            return LuaReturn.Ok
        }, 'ii')
    }

    // A base implementation that assumes user data serialisation
    public getValue(thread: Thread, index: number, _cache?: LuaGetCache): T {
        const refUserdata = thread.module.luaL_testudata(thread.address, index, this.name)
        if (!refUserdata) {
            throw new Error(`data does not have the expected metatable: ${this.name}`)
        }
        const referencePointer = thread.module.emscripten.getValue(refUserdata, '*')
        return thread.module.getRef(referencePointer) as T
    }

    // Return false if type not matched, otherwise true. This base method does not
    // check the type. That must be done by the class extending this.
    public pushValue(thread: Thread, decoratedValue: Decoration<unknown>, _cache?: LuaPushCache): boolean {
        const { target } = decoratedValue

        const pointer = thread.module.ref(target)
        // 4 = size of pointer in wasm.
        const userDataPointer = thread.module.lua_newuserdatauv(thread.address, PointerSize, 0)
        thread.module.emscripten.setValue(userDataPointer, pointer, '*')

        if (LuaType.Nil === thread.module.luaL_getmetatable(thread.address, this.name)) {
            // Pop the pushed nil value and the user data. Don't need to unref because it's
            // already associated with the user data pointer.
            thread.pop(2)
            throw new Error(`metatable not found: ${this.name}`)
        }

        // Set as the metatable for the userdata.
        // -1 is the metatable, -2 is the user data.
        thread.module.lua_setmetatable(thread.address, -2)

        return true
    }
}
