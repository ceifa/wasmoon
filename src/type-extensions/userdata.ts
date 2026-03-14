import { BaseDecorationOptions, Decoration } from '../decoration'
import Global from '../global'
import Thread from '../thread'
import TypeExtension from '../type-extension'
import { LuaReturn, LuaState, LuaType } from '../types'

export interface UserdataDecorationOptions extends BaseDecorationOptions {
    reference?: boolean
}

export function decorateUserdata(t: unknown): Decoration<any, UserdataDecorationOptions> {
    return new Decoration<any, UserdataDecorationOptions>(t, { reference: true })
}

class UserdataTypeExtension extends TypeExtension<any, UserdataDecorationOptions> {
    private readonly gcPointer: number

    public constructor(t: Global) {
        super(t, 'js_userdata')

        this.gcPointer = t.lua._emscripten.addFunction((s: LuaState) => {
            // Throws a lua error which does a jump if it does not match.
            const userDataPointer = t.lua.luaL_checkudata(s, 1, this.name)
            const referencePointer = t.lua._emscripten.getValue(userDataPointer, '*')
            t.lua.unref(referencePointer)

            return LuaReturn.Ok
        }, 'ii')

        if (t.lua.luaL_newmetatable(t.address, this.name)) {
            const metatableIndex = t.lua.lua_gettop(t.address)

            // Mark it as uneditable
            t.lua.lua_pushstring(t.address, 'protected metatable')
            t.lua.lua_setfield(t.address, metatableIndex, '__metatable')

            // Add the gc function
            t.lua.lua_pushcclosure(t.address, this.gcPointer, 0)
            t.lua.lua_setfield(t.address, metatableIndex, '__gc')
        }

        // Pop the metatable from the stack.
        t.lua.lua_pop(t.address, 1)
    }

    public isType(_t: Thread, _i: number, t: LuaType, n?: string): boolean {
        return t === LuaType.Userdata && n === this.name
    }

    public getValue(t: Thread, i: number): any {
        const refUserdata = t.lua.lua_touserdata(t.address, i)
        const referencePointer = t.lua._emscripten.getValue(refUserdata, '*')
        return t.lua.getRef(referencePointer)
    }

    public pushValue(t: Thread, d: Decoration<any, UserdataDecorationOptions>): boolean {
        if (!d.options.reference) {
            return false
        }

        return super.pushValue(t, d)
    }

    public close(): void {
        this.thread.lua._emscripten.removeFunction(this.gcPointer)
    }
}

export default function createTypeExtension(t: Global): TypeExtension<Error> {
    return new UserdataTypeExtension(t)
}
