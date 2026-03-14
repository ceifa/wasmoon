import { BaseDecorationOptions, Decoration } from '../decoration'
import Global from '../global'
import MultiReturn from '../multireturn'
import Thread from '../thread'
import TypeExtension from '../type-extension'
import { LuaReturn, LuaState, LuaType } from '../types'
import { isPromise } from '../utils'
import { decorateFunction } from './function'

export interface ProxyDecorationOptions extends BaseDecorationOptions {
    // If undefined, will try to figure out if should proxy
    proxy?: boolean
}

export function decorateProxy(t: unknown, o?: ProxyDecorationOptions): Decoration<any, ProxyDecorationOptions> {
    return new Decoration<any, ProxyDecorationOptions>(t, o || {})
}

class ProxyTypeExtension extends TypeExtension<any, ProxyDecorationOptions> {
    private readonly gcPointer: number

    public constructor(t: Global) {
        super(t, 'js_proxy')

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

            t.pushValue((self: any, key: unknown) => {
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
                    return decorateFunction(value as (...args: any[]) => any, { self })
                }

                return value
            })
            t.lua.lua_setfield(t.address, metatableIndex, '__index')

            t.pushValue((self: any, key: unknown, value: any) => {
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
            t.lua.lua_setfield(t.address, metatableIndex, '__newindex')

            t.pushValue((self: any) => {
                return self.toString?.() ?? typeof self
            })
            t.lua.lua_setfield(t.address, metatableIndex, '__tostring')

            t.pushValue((self: any) => {
                return self.length || 0
            })
            t.lua.lua_setfield(t.address, metatableIndex, '__len')

            t.pushValue((self: any) => {
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
            t.lua.lua_setfield(t.address, metatableIndex, '__pairs')

            t.pushValue((self: any, other: any) => {
                return self === other
            })
            t.lua.lua_setfield(t.address, metatableIndex, '__eq')

            t.pushValue((self: any, ...args: any[]) => {
                if (args[0] === self) {
                    args.shift()
                }
                return self(...args)
            })
            t.lua.lua_setfield(t.address, metatableIndex, '__call')
        }

        // Pop the metatable from the stack.
        t.lua.lua_pop(t.address, 1)
    }

    public isType(_t: Thread, _i: number, t: LuaType, n?: string): boolean {
        // Capture proxied types and functions returned by lua.
        return t === LuaType.Userdata && n === this.name
    }

    public getValue(t: Thread, i: number): any {
        const refUserdata = t.lua.lua_touserdata(t.address, i)
        const referencePointer = t.lua._emscripten.getValue(refUserdata, '*')
        return t.lua.getRef(referencePointer)
    }

    public pushValue(t: Thread, d: Decoration<any, ProxyDecorationOptions>): boolean {
        const { target, options } = d
        if (options.proxy === undefined) {
            if (target === null || target === undefined) {
                return false
            }

            if (typeof target !== 'object') {
                const isClass =
                    typeof target === 'function' && target.prototype?.constructor === target && target.toString().startsWith('class ')

                if (!isClass) {
                    return false
                }
            }

            if (isPromise(target)) {
                return false
            }
        } else if (options.proxy === false) {
            return false
        }

        if (options.metatable && !(options.metatable instanceof Decoration)) {
            // Otherwise the metatable will get converted into a JS ref rather than being set as a standard
            // table. This forces it to use the standard table type.
            d.options.metatable = decorateProxy(options.metatable, { proxy: false })
            return false
        }

        return super.pushValue(t, d)
    }

    public close(): void {
        this.thread.lua._emscripten.removeFunction(this.gcPointer)
    }
}

export default function createTypeExtension(t: Global): TypeExtension<any, ProxyDecorationOptions> {
    return new ProxyTypeExtension(t)
}
