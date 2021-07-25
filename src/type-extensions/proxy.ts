import { BaseDecorationOptions, Decoration } from '../decoration'
import { LuaReturn, LuaState, LuaType } from '../types'
import { decorateFunction } from './function'
import Global from '../global'
import MultiReturn from '../multireturn'
import Thread from '../thread'
import TypeExtension from '../type-extension'

export interface ProxyDecorationOptions extends BaseDecorationOptions {
    // If undefined, will try to figure out if should proxy
    proxy?: boolean
}

export function decorateProxy(target: unknown, options?: ProxyDecorationOptions): Decoration<any, ProxyDecorationOptions> {
    return new Decoration<any, ProxyDecorationOptions>(target, options || {})
}

class ProxyTypeExtension extends TypeExtension<any, ProxyDecorationOptions> {
    private readonly gcPointer: number

    public constructor(thread: Global) {
        super(thread, 'js_proxy')

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

            thread.pushValue((self: any, key: unknown) => {
                switch (typeof key) {
                    case 'number':
                        // Map from Lua's 1 based indexing to JS's 0.
                        // This is especially important here because ipairs just calls
                        // __index with 1, 2, 3, 4 etc until there's a null.
                        key = key - 1
                    // Fallthrough
                    case 'string':
                        break
                    default:
                        throw new Error('Only strings or numbers can index js objects')
                }

                const value = self[key as string | number]
                if (typeof value === 'function') {
                    return decorateFunction(value, { self })
                }

                return value
            })
            thread.lua.lua_setfield(thread.address, metatableIndex, '__index')

            thread.pushValue((self: any, key: unknown, value: any) => {
                switch (typeof key) {
                    case 'number':
                        // Map from Lua's 1 based indexing to JS's 0.
                        key = key - 1
                    // Fallthrough
                    case 'string':
                        break
                    default:
                        throw new Error('Only strings or numbers can index js objects')
                }
                self[key as string | number] = value
            })
            thread.lua.lua_setfield(thread.address, metatableIndex, '__newindex')

            thread.pushValue((self: any) => {
                return self.toString?.() ?? typeof self
            })
            thread.lua.lua_setfield(thread.address, metatableIndex, '__tostring')

            thread.pushValue((self: any) => {
                return self.length || 0
            })
            thread.lua.lua_setfield(thread.address, metatableIndex, '__len')

            thread.pushValue((self: any) => {
                const keys = Object.getOwnPropertyNames(self)
                let i = 0
                // Stateful rather than stateless. First call is with nil.
                return MultiReturn.of(
                    () => {
                        const ret = MultiReturn.of(keys[i], self[keys[i]])
                        i++
                        return ret
                    },
                    self,
                    null,
                )
            })
            thread.lua.lua_setfield(thread.address, metatableIndex, '__pairs')

            thread.pushValue((self: any, other: any) => {
                return self === other
            })
            thread.lua.lua_setfield(thread.address, metatableIndex, '__eq')

            thread.pushValue((self: any, ...args: any[]) => {
                if (args[0] === self) {
                    args.shift()
                }
                return self(...args)
            })
            thread.lua.lua_setfield(thread.address, metatableIndex, '__call')
        }

        // Pop the metatable from the stack.
        thread.lua.lua_pop(thread.address, 1)
    }

    public isType(_thread: Thread, _index: number, type: LuaType, name?: string): boolean {
        // Capture proxied types and functions returned by lua.
        return type === LuaType.UserData && name === this.name
    }

    public getValue(thread: Thread, index: number): any {
        const refUserData = thread.lua.lua_touserdata(thread.address, index)
        const referencePointer = thread.lua.module.getValue(refUserData, '*')
        return thread.lua.getRef(referencePointer)
    }

    public pushValue(thread: Thread, decoratedValue: Decoration<any, ProxyDecorationOptions>, parent?: any): boolean {
        const { target, options } = decoratedValue
        if (options?.proxy === undefined) {
            if (target === null || target === undefined) {
                return false
            }

            if (typeof target !== 'object') {
                const isClass =
                    typeof target === 'function' && target?.prototype?.constructor === target && target.toString().startsWith('class ')

                if (!isClass) {
                    return false
                }
            }

            if (Promise.resolve(target) === target) {
                return false
            }
        } else if (options?.proxy === false) {
            return false
        }

        if (decoratedValue.options.metatable && !(decoratedValue.options.metatable instanceof Decoration)) {
            // Otherwise the metatable will get converted into a JS ref rather than being set as a standard
            // table. This forces it to use the standard table type.
            decoratedValue.options.metatable = decorateProxy(decoratedValue.options.metatable, { proxy: false })
            return false
        }

        return super.pushValue(thread, decoratedValue, parent)
    }

    public close(): void {
        this.thread.lua.module.removeFunction(this.gcPointer)
    }
}

export default function createTypeExtension(thread: Global): TypeExtension<any, ProxyDecorationOptions> {
    return new ProxyTypeExtension(thread)
}
