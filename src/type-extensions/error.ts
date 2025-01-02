import { Decoration } from '../decoration'
import Global from '../global'
import Thread from '../thread'
import TypeExtension from '../type-extension'
import { LuaReturn, LuaState } from '../types'

class ErrorTypeExtension extends TypeExtension<Error> {
    private gcPointer: number

    public constructor(thread: Global, injectObject: boolean) {
        super(thread, 'js_error')

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

            // Add an __index method that returns the message field
            thread.pushValue((jsRefError: Error, key: unknown) => {
                if (key === 'message') {
                    return jsRefError.message
                }
                return null
            })
            thread.lua.lua_setfield(thread.address, metatableIndex, '__index')

            // Add a tostring method that returns the message.
            thread.pushValue((jsRefError: Error) => {
                // The message rather than toString to avoid the Error: prefix being
                // added. This fits better with Lua errors.
                return jsRefError.message
            })
            thread.lua.lua_setfield(thread.address, metatableIndex, '__tostring')
        }
        // Pop the metatable from the stack.
        thread.lua.lua_pop(thread.address, 1)

        if (injectObject) {
            // Lastly create a static Promise constructor.
            thread.set('Error', {
                create: (message: string | undefined) => {
                    if (message && typeof message !== 'string') {
                        throw new Error('message must be a string')
                    }

                    return new Error(message)
                },
            })
        }
    }

    public pushValue(thread: Thread, decoration: Decoration<Error>): boolean {
        if (!(decoration.target instanceof Error)) {
            return false
        }
        return super.pushValue(thread, decoration)
    }

    public close(): void {
        this.thread.lua.module.removeFunction(this.gcPointer)
    }
}

export default function createTypeExtension(thread: Global, injectObject: boolean): TypeExtension<Error> {
    return new ErrorTypeExtension(thread, injectObject)
}
