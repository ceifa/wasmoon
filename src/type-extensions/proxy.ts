import { BoundMethod } from '../marshal'
import type LuaState from '../state'
import MultiReturn from '../multireturn'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import { type LuaAddress, LuaType } from '../types'
import { isEmscriptenUnwind } from '../utils'

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
    private readonly functionMetamethods: number[] = []

    public constructor(state: LuaState) {
        super(state, 'js_proxy')

        this.deferMetatable(() => ({
            __index: (self: any, key: unknown) => this.index(self, key),
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

    public override close(): void {
        for (const pointer of this.functionMetamethods) {
            this.state.module.removeFunction(pointer)
        }
    }

    /**
     * Lua has a single metatable for every function, and indexing one goes to it. Filled here, by
     * the first proxy, so that a method read off a proxy stays a plain function -- called as fast
     * as one, and taken by everything in Lua that wants one -- whose members are still reachable:
     * `window.Date.now()`, `window.URL.new(href)`. Any other function indexes as Lua's do.
     */
    protected override defineMetatable(metamethods?: Record<string, unknown>): void {
        super.defineMetatable(metamethods)
        const { module, address: L } = this.state

        // A function to set the metatable through, the __index itself.
        const index = this.functionMetamethod((target, thread) => thread.pushReturnValues(this.index(target, thread.getValue(2))))
        module.lua_pushnil(L)
        module.wasmoon_push_jsfunction(L, index)
        const created = !module.lua_getmetatable(L, -1)
        if (created) {
            module.lua_createtable(L, 0, 3)
            module.lua_pushstring(L, 'protected metatable')
            module.lua_setfield(L, -2, '__metatable')
        }
        // One someone set before is left alone, and only completed.
        if (module.lua_getfield(L, -1, '__index') === LuaType.Nil) {
            module.lua_pushvalue(L, -3)
            module.lua_setfield(L, -3, '__index')
        }
        module.lua_pop(L, 1)
        if (module.lua_getfield(L, -1, '__newindex') === LuaType.Nil) {
            const newindex = this.functionMetamethod((target, thread) => {
                target[toJsKey(target, thread.getValue(2))] = thread.getValue(3)
                return 0
            })
            module.lua_pushnil(L)
            module.wasmoon_push_jsfunction(L, newindex)
            module.lua_setfield(L, -3, '__newindex')
        }
        module.lua_pop(L, 1)
        module.lua_setmetatable(L, -2)
        module.lua_pop(L, 1)
    }

    /**
     * A C function for the function metatable, through the trampoline every JS function takes so a
     * call can suspend, which calls `body` with the method being indexed. Not a JS function
     * pushed like any other, which would be handed the method already read back as its function.
     */
    private functionMetamethod(body: (target: any, thread: Thread) => number): number {
        const { module, marshaller } = this.state
        const pointer = module.addFunction((L: LuaAddress) => {
            const method = marshaller.functions.methodAt(L, 1)
            if (method === undefined) {
                module.luaL_where(L, 1)
                module.lua_pushstring(L, 'attempt to index a function value')
                module.lua_concat(L, 2)
                return module.lua_error(L)
            }
            const thread = this.state.stateToThread(L)
            try {
                return body(method.target, thread)
            } catch (err) {
                if (isEmscriptenUnwind(err)) {
                    throw err
                }
                thread.pushValue(err)
            }
            return module.lua_error(L)
        }, 'ii')
        this.functionMetamethods.push(pointer)
        return pointer
    }

    private index(self: any, key: unknown): unknown {
        const jsKey = toJsKey(self, key)
        const value = self[jsKey]
        if (typeof value === 'function') {
            // A class the state knows crosses as that class, wherever it is found.
            return this.state.marshaller.hasClass(value) ? value : this.bindMethod(self, value as AnyFunction)
        }
        // Lua has no `new`, and whether a function wants one cannot be told from the outside, so
        // constructing is spelled out: `Class.new(...)`.
        if (value === undefined && jsKey === 'new' && typeof self === 'function') {
            return this.constructorOf(self as AnyFunction)
        }
        return value
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
