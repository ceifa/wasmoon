import { Decoration } from '../decoration'
import type LuaState from '../state'
import type Thread from '../thread'
import TypeExtension from '../type-extension'

class ErrorTypeExtension extends TypeExtension<Error> {
    private gcPointer: number

    public constructor(state: LuaState, injectObject: boolean) {
        super(state, 'js_error')

        this.gcPointer = this.createGcFunction()

        if (state.lua.luaL_newmetatable(state.address, this.name)) {
            const metatableIndex = state.lua.lua_gettop(state.address)

            // Mark it as uneditable
            state.lua.lua_pushstring(state.address, 'protected metatable')
            state.lua.lua_setfield(state.address, metatableIndex, '__metatable')

            // Add the gc function
            state.lua.lua_pushcclosure(state.address, this.gcPointer, 0)
            state.lua.lua_setfield(state.address, metatableIndex, '__gc')

            // Add an __index method that returns the message field
            state.pushValue((jsRefError: Error, key: unknown) => {
                if (key === 'message') {
                    return jsRefError.message
                }
                return null
            })
            state.lua.lua_setfield(state.address, metatableIndex, '__index')

            // Add a tostring method that returns the message.
            state.pushValue((jsRefError: Error) => {
                // The message rather than toString to avoid the Error: prefix being
                // added. This fits better with Lua errors.
                return jsRefError.message
            })
            state.lua.lua_setfield(state.address, metatableIndex, '__tostring')
        }
        // Pop the metatable from the stack.
        state.lua.lua_pop(state.address, 1)

        if (injectObject) {
            // Lastly create a static Error constructor.
            state.set('Error', {
                create: (message: string | undefined) => {
                    if (message && typeof message !== 'string') {
                        throw new Error('message must be a string')
                    }

                    return new Error(message)
                },
            })
        }
    }

    public pushValue(thread: Thread, decoration: Decoration<unknown>): boolean {
        if (!(decoration.target instanceof Error)) {
            return false
        }
        return super.pushValue(thread, decoration)
    }

    public close(): void {
        this.state.lua._emscripten.removeFunction(this.gcPointer)
    }
}

export default function createTypeExtension(state: LuaState, injectObject: boolean): TypeExtension<Error> {
    return new ErrorTypeExtension(state, injectObject)
}
