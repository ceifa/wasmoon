import { decorate, Decoration } from '../decoration'
import type LuaState from '../state'
import MultiReturn from '../multireturn'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import { LuaType } from '../types'
import { isPromise } from '../utils'

class ProxyTypeExtension extends TypeExtension<any> {
    private readonly gcPointer: number

    public constructor(state: LuaState) {
        super(state, 'js_proxy')

        this.gcPointer = this.createGcFunction()

        if (state.lua.luaL_newmetatable(state.address, this.name)) {
            const metatableIndex = state.lua.lua_gettop(state.address)

            // Mark it as uneditable
            state.lua.lua_pushstring(state.address, 'protected metatable')
            state.lua.lua_setfield(state.address, metatableIndex, '__metatable')

            // Add the gc function
            state.lua.lua_pushcclosure(state.address, this.gcPointer, 0)
            state.lua.lua_setfield(state.address, metatableIndex, '__gc')

            state.pushValue((self: any, key: unknown) => {
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
                    return decorate(value as (...args: any[]) => any, { self })
                }

                return value
            })
            state.lua.lua_setfield(state.address, metatableIndex, '__index')

            state.pushValue((self: any, key: unknown, value: any) => {
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
            state.lua.lua_setfield(state.address, metatableIndex, '__newindex')

            state.pushValue((self: any) => {
                return self.toString?.() ?? typeof self
            })
            state.lua.lua_setfield(state.address, metatableIndex, '__tostring')

            state.pushValue((self: any) => {
                return self.length || 0
            })
            state.lua.lua_setfield(state.address, metatableIndex, '__len')

            state.pushValue((self: any) => {
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
            state.lua.lua_setfield(state.address, metatableIndex, '__pairs')

            state.pushValue((self: any, other: any) => {
                return self === other
            })
            state.lua.lua_setfield(state.address, metatableIndex, '__eq')

            state.pushValue((self: any, ...args: any[]) => {
                if (args[0] === self) {
                    args.shift()
                }
                return self(...args)
            })
            state.lua.lua_setfield(state.address, metatableIndex, '__call')
        }

        // Pop the metatable from the stack.
        state.lua.lua_pop(state.address, 1)
    }

    public isType(_thread: Thread, _index: number, type: LuaType, name?: string): boolean {
        // Capture proxied types and functions returned by lua.
        return type === LuaType.Userdata && name === this.name
    }

    public getValue(thread: Thread, index: number): any {
        const refUserdata = thread.lua.lua_touserdata(thread.address, index)
        const referencePointer = thread.lua._emscripten.getValue(refUserdata, '*')
        return thread.lua.getRef(referencePointer)
    }

    public pushValue(thread: Thread, decoratedValue: Decoration<unknown>): boolean {
        const { target, options } = decoratedValue
        if (options.as === undefined) {
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
        } else if (options.as !== 'proxy') {
            // Both 'userdata' and 'value' mean "do not go through the proxy layer".
            return false
        }

        if (options.metatable && !(options.metatable instanceof Decoration)) {
            // Otherwise the metatable will get converted into a JS ref rather than being set as a standard
            // table. This forces it to use the standard table type.
            decoratedValue.options.metatable = decorate(options.metatable, { as: 'value' })
            return false
        }

        return super.pushValue(thread, decoratedValue)
    }

    public close(): void {
        this.state.lua._emscripten.removeFunction(this.gcPointer)
    }
}

export default function createTypeExtension(state: LuaState): TypeExtension<any> {
    return new ProxyTypeExtension(state)
}
