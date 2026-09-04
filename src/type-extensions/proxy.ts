import { decorate, Decoration } from '../decoration'
import type LuaState from '../state'
import MultiReturn from '../multireturn'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import { LuaType } from '../types'
import { isPromise } from '../utils'

const isClass = (target: unknown): target is new (...args: any[]) => any =>
    target === Date || (typeof target === 'function' && target.prototype?.constructor === target && target.toString().startsWith('class '))

const isClassLike = (target: unknown): boolean => {
    if (typeof target !== 'function' || !target.prototype || target.prototype.constructor !== target) {
        return false
    }
    return isClass(target) || Object.getOwnPropertyNames(target.prototype).length > 1
}

class ProxyTypeExtension extends TypeExtension<any> {
    private readonly gcPointer: number
    private readonly boundMethods = new WeakMap<object, WeakMap<(...args: any[]) => any, Decoration<(...args: any[]) => any>>>()

    public constructor(state: LuaState) {
        super(state, 'js_proxy')

        this.gcPointer = this.createGcFunction()

        if (state.module.luaL_newmetatable(state.address, this.name)) {
            const metatableIndex = state.module.lua_gettop(state.address)

            // Mark it as uneditable
            state.module.lua_pushstring(state.address, 'protected metatable')
            state.module.lua_setfield(state.address, metatableIndex, '__metatable')

            // Add the gc function
            state.module.lua_pushcclosure(state.address, this.gcPointer, 0)
            state.module.lua_setfield(state.address, metatableIndex, '__gc')

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
                    return this.bindMethod(self, value as (...args: any[]) => any)
                }

                return value
            })
            state.module.lua_setfield(state.address, metatableIndex, '__index')

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
            state.module.lua_setfield(state.address, metatableIndex, '__newindex')

            state.pushValue((self: any) => {
                return self.toString?.() ?? typeof self
            })
            state.module.lua_setfield(state.address, metatableIndex, '__tostring')

            state.pushValue((self: any) => {
                return self.length || 0
            })
            state.module.lua_setfield(state.address, metatableIndex, '__len')

            state.pushValue((self: any) => {
                const isArray = Array.isArray(self)
                const keys = isArray ? self : Object.keys(self)
                let i = 0
                // Stateful rather than stateless. First call is with nil.
                return MultiReturn.of(
                    () => {
                        if (i >= keys.length) {
                            return undefined
                        }
                        const ret = isArray ? MultiReturn.of(i + 1, self[i]) : MultiReturn.of(keys[i], self[keys[i]])
                        i++
                        return ret
                    },
                    self,
                    null,
                )
            })
            state.module.lua_setfield(state.address, metatableIndex, '__pairs')

            state.pushValue((self: any, other: any) => {
                return self === other
            })
            state.module.lua_setfield(state.address, metatableIndex, '__eq')

            state.pushValue((self: any, ...args: any[]) => {
                if (args[0] === self) {
                    args.shift()
                }
                return isClass(self) ? new self(...args) : self(...args)
            })
            state.module.lua_setfield(state.address, metatableIndex, '__call')
        }

        // Pop the metatable from the stack.
        state.module.lua_pop(state.address, 1)
    }

    private bindMethod(self: object, method: (...args: any[]) => any): Decoration<(...args: any[]) => any> {
        let methods = this.boundMethods.get(self)
        if (!methods) {
            methods = new WeakMap()
            this.boundMethods.set(self, methods)
        }
        let bound = methods.get(method)
        if (!bound) {
            bound = decorate(method, { self })
            methods.set(method, bound)
        }
        return bound
    }

    public isType(_thread: Thread, _index: number, type: LuaType, name?: string): boolean {
        // Capture proxied types and functions returned by lua.
        return type === LuaType.Userdata && name === this.name
    }

    public getValue(thread: Thread, index: number): any {
        const refUserdata = thread.module.lua_touserdata(thread.address, index)
        const referencePointer = thread.module.readPointer(refUserdata)
        return thread.module.getRef(referencePointer)
    }

    public pushValue(thread: Thread, decoratedValue: Decoration<unknown>): boolean {
        const { target, options } = decoratedValue
        if (options.as === undefined) {
            if (target === null || target === undefined) {
                return false
            }

            if (typeof target !== 'object' && !isClassLike(target)) {
                return false
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
        this.state.module.removeFunction(this.gcPointer)
    }
}

export default function createTypeExtension(state: LuaState): TypeExtension<any> {
    return new ProxyTypeExtension(state)
}
