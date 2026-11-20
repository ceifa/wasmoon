import { BoundMethod } from '../marshal'
import type LuaState from '../state'
import MultiReturn from '../multireturn'
import type Thread from '../thread'
import TypeExtension from '../type-extension'

type AnyFunction = (...args: any[]) => any

/**
 * Lua indexes a JS value with the key as given, except that an array is indexed from 1 the way a
 * Lua sequence is -- which matters most for ipairs, which calls __index with 1, 2, 3... until it
 * gets nil. Only an array: on any other object a number is the property it names.
 */
const toJsKey = (target: unknown, key: unknown): string | number => {
    switch (typeof key) {
        case 'number':
            return Array.isArray(target) ? key - 1 : key
        case 'string':
            return key
        default:
            throw new Error('Only strings or numbers can index js objects')
    }
}

/**
 * What an object is pushed as when the state's `objects` is `'proxy'`, and anything wrapped in
 * `proxy(value)`: a userdata that forwards to the JS value.
 */
class ProxyTypeExtension extends TypeExtension<any> {
    private readonly boundMethods = new WeakMap<object, WeakMap<AnyFunction, BoundMethod>>()
    private readonly constructors = new WeakMap<AnyFunction, AnyFunction>()

    public constructor(state: LuaState) {
        super(state, 'js_proxy')

        this.deferMetatable(() => ({
            __index: (self: any, key: unknown) => {
                const jsKey = toJsKey(self, key)
                const value = self[jsKey]
                if (typeof value === 'function') {
                    // A class the state knows crosses as that class, wherever it is found.
                    return state.marshaller.hasClass(value) ? value : this.bindMethod(self, value as AnyFunction)
                }
                // Lua has no `new`, and whether a function wants one cannot be told from the
                // outside, so constructing is spelled out: `Class.new(...)`.
                if (value === undefined && jsKey === 'new' && typeof self === 'function') {
                    return this.constructorOf(self as AnyFunction)
                }
                return value
            },
            __newindex: (self: any, key: unknown, value: any) => {
                self[toJsKey(self, key)] = value
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
            __call: (self: any, ...args: any[]) => self(...args),
        }))
    }

    public push(thread: Thread, target: unknown): void {
        this.pushReference(thread, target)
    }

    private bindMethod(self: object, method: AnyFunction): BoundMethod {
        let methods = this.boundMethods.get(self)
        if (!methods) {
            methods = new WeakMap()
            this.boundMethods.set(self, methods)
        }
        let bound = methods.get(method)
        if (!bound) {
            bound = new BoundMethod(method, self)
            methods.set(method, bound)
        }
        return bound
    }

    /** One per function, so `Class.new == Class.new` in Lua. */
    private constructorOf(target: AnyFunction): AnyFunction {
        let construct = this.constructors.get(target)
        if (!construct) {
            construct = (...args: any[]) => Reflect.construct(target, args)
            this.constructors.set(target, construct)
        }
        return construct
    }
}

export default function createTypeExtension(state: LuaState): ProxyTypeExtension {
    return new ProxyTypeExtension(state)
}
export type { ProxyTypeExtension }
