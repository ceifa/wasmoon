import { decorate, Decoration } from '../decoration'
import type LuaState from '../state'
import MultiReturn from '../multireturn'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import { isPromise } from '../utils'

const isClass = (target: unknown): target is new (...args: any[]) => any =>
    target === Date || (typeof target === 'function' && target.prototype?.constructor === target && target.toString().startsWith('class '))

const isClassLike = (target: unknown): boolean => {
    if (typeof target !== 'function' || !target.prototype || target.prototype.constructor !== target) {
        return false
    }
    return isClass(target) || Object.getOwnPropertyNames(target.prototype).length > 1
}

/**
 * Lua indexes js objects with the key as given, except that a number is mapped from Lua's 1 based
 * indexing to JS's 0 -- which matters most for ipairs, which calls __index with 1, 2, 3... until
 * it gets nil.
 */
const toJsKey = (key: unknown): string | number => {
    switch (typeof key) {
        case 'number':
            return key - 1
        case 'string':
            return key
        default:
            throw new Error('Only strings or numbers can index js objects')
    }
}

class ProxyTypeExtension extends TypeExtension<any> {
    private readonly boundMethods = new WeakMap<object, WeakMap<(...args: any[]) => any, Decoration<(...args: any[]) => any>>>()

    public constructor(state: LuaState) {
        super(state, 'js_proxy')

        this.defineMetatable({
            __index: (self: any, key: unknown) => {
                const value = self[toJsKey(key)]
                if (typeof value === 'function') {
                    return this.bindMethod(self, value as (...args: any[]) => any)
                }
                return value
            },
            __newindex: (self: any, key: unknown, value: any) => {
                self[toJsKey(key)] = value
            },
            __tostring: (self: any) => self.toString?.() ?? typeof self,
            __len: (self: any) => self.length || 0,
            __pairs: (self: any) => {
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
            },
            __eq: (self: any, other: any) => self === other,
            __call: (self: any, ...args: any[]) => {
                if (args[0] === self) {
                    args.shift()
                }
                return isClass(self) ? new self(...args) : self(...args)
            },
        })
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

    public getValue(thread: Thread, index: number): any {
        // isType has already matched the metatable, so the check is not paid for again here.
        return thread.module.getReferenceBox(thread.address, index)
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
}

export default function createTypeExtension(state: LuaState): TypeExtension<any> {
    return new ProxyTypeExtension(state)
}
