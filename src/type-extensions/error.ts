import type { Decoration } from '../decoration'
import type LuaState from '../state'
import type Thread from '../thread'
import TypeExtension from '../type-extension'

class ErrorTypeExtension extends TypeExtension<Error> {
    public constructor(state: LuaState, injectObject: boolean) {
        super(state, 'js_error')

        this.defineMetatable({
            __index: (jsRefError: Error, key: unknown) => {
                switch (key) {
                    case 'message':
                        return jsRefError.message
                    case 'name':
                        return jsRefError.name
                    case 'stack':
                        return jsRefError.stack
                    default:
                        return undefined
                }
            },
            // The message rather than toString to avoid the Error: prefix being
            // added. This fits better with Lua errors.
            __tostring: (jsRefError: Error) => jsRefError.message,
        })

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
        // An explicit `as` names a representation this extension does not provide.
        if (decoration.options.as !== undefined) {
            return false
        }
        return super.pushValue(thread, decoration)
    }
}

export default function createTypeExtension(state: LuaState, injectObject: boolean): TypeExtension<Error> {
    return new ErrorTypeExtension(state, injectObject)
}
