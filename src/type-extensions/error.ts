import { LuaReturn, LuaState } from '../types'
import Thread from '../thread'
import TypeExtension from '../type-extension'

class ErrorTypeExtension extends TypeExtension<Error> {
    private gcPointer: number

    public constructor(thread: Thread) {
        super(thread, 'js_error')

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

            // Add an __index method that returns the message field
            thread.pushValue((jsRefError: Error, key: unknown) => {
                if (key === 'message') {
                    return jsRefError.message
                }
                return null
            })
            thread.cmodule.lua_setfield(thread.address, metatableIndex, '__index')

            // Add a tostring method that returns the message.
            thread.pushValue((jsRefError: Error) => {
                return jsRefError.message
            })
            thread.cmodule.lua_setfield(thread.address, metatableIndex, '__tostring')
        }
        // Pop the metatable from the stack.
        thread.cmodule.lua_pop(thread.address, 1)

        // Lastly create a static Promise constructor.
        thread.set('Error', {
            create: (message: any) => {
                if (message && typeof message !== 'string') {
                    throw new Error('message must be a string')
                }

                return new Error(message)
            },
        })
    }

    public pushValue(thread: Thread, value: unknown): boolean {
        if (!(value instanceof Error)) {
            return false
        }
        return super.pushValue(thread, value)
    }

    public close(): void {
        this.thread.cmodule.module.removeFunction(this.gcPointer)
    }
}

export default function createTypeExtension(thread: Thread): TypeExtension<Error> {
    return new ErrorTypeExtension(thread)
}
