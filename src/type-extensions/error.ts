import { copy } from '../marshal'
import type LuaState from '../state'
import type Thread from '../thread'
import TypeExtension from '../type-extension'

/**
 * A JS `Error` in Lua: a read-only userdata that renders as its message and exposes `message`,
 * `name`, `stack` and whatever the error carries as own properties (`code`, `cause`, ...).
 * Nothing inherited is reachable, so an error thrown into a state that copies its objects does not
 * hand Lua a way back into JS.
 */
class ErrorTypeExtension extends TypeExtension<Error> {
    public constructor(state: LuaState, injectObject: boolean) {
        super(state, 'js_error')

        this.deferMetatable(() => ({
            __index: (error: Error, key: unknown) => {
                switch (key) {
                    case 'message':
                        return error.message
                    case 'name':
                        return error.name
                    case 'stack':
                        return error.stack
                    default:
                        return typeof key === 'string' && Object.hasOwn(error, key)
                            ? (error as unknown as Record<string, unknown>)[key]
                            : undefined
                }
            },
            // The message rather than toString to avoid the Error: prefix being
            // added. This fits better with Lua errors.
            __tostring: (error: Error) => error.message,
        }))

        if (injectObject) {
            // Lastly create a static Error constructor.
            state.set(
                'Error',
                copy({
                    create: (message: string | undefined) => {
                        if (message && typeof message !== 'string') {
                            throw new Error('message must be a string')
                        }

                        return new Error(message)
                    },
                }),
            )
        }
    }

    public push(thread: Thread, error: Error): void {
        this.pushReference(thread, error)
    }
}

export default function createTypeExtension(state: LuaState, injectObject: boolean): ErrorTypeExtension {
    return new ErrorTypeExtension(state, injectObject)
}
export type { ErrorTypeExtension }
