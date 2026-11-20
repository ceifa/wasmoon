import { copy } from '../marshal'
import type LuaState from '../state'
import type Thread from '../thread'
import TypeExtension from '../type-extension'
import type { LuaClass, LuaClassOptions } from '../types'

type AnyFunction = (...args: any[]) => any

/**
 * An instance's `__index`, as a chunk that takes the table of methods and the JS function that
 * reads everything else. Looking a method up is then a table access inside Lua, and only a field
 * or an accessor crosses into JS.
 */
const INDEX_SOURCE = `local methods, get = ...
return function(self, key)
    local method = methods[key]
    if method ~= nil then return method end
    return get(self, key)
end`

const RESERVED_METAMETHODS = ['__gc', '__metatable', '__name']

const classNameOf = (ctor: LuaClass, options: LuaClassOptions): string => {
    if (typeof ctor !== 'function' || typeof ctor.prototype !== 'object' || ctor.prototype === null) {
        throw new TypeError('defineClass expects a class')
    }
    const name = options.name ?? ctor.name
    if (!name) {
        throw new TypeError('defineClass needs a name for an anonymous class, pass one as options.name')
    }
    return name
}

/** Where a number indexes from: an `Array` subclass is a sequence in Lua like any other array. */
const toJsIndex = (target: unknown, key: number): number => (Array.isArray(target) ? key - 1 : key)

/** The class itself in Lua: called to construct, indexed for its static members. */
class ClassObjectExtension extends TypeExtension<LuaClass> {
    private readonly staticMethods = new Map<string, AnyFunction>()
    private readonly construct: AnyFunction

    public constructor(
        state: LuaState,
        name: string,
        private readonly ctor: LuaClass,
        private readonly allowed: ReadonlySet<string> | undefined,
    ) {
        super(state, `${name}.class`)
        this.construct = (...args: any[]) => Reflect.construct(ctor, args)

        this.defineMetatable(
            {
                __call: (_self: unknown, ...args: any[]) => Reflect.construct(ctor, args),
                __index: (_self: unknown, key: unknown) => this.get(key),
                __tostring: () => `class ${name}`,
            },
            { exclusive: true },
        )
    }

    public push(thread: Thread): void {
        this.pushReference(thread, this.ctor)
    }

    private get(key: unknown): unknown {
        if (typeof key !== 'string') {
            return undefined
        }
        if (this.allowed ? !this.allowed.has(key) : !this.isStatic(key)) {
            // Constructing is always spelled both ways, `Class(...)` and `Class.new(...)`.
            return key === 'new' ? this.construct : undefined
        }
        const value = (this.ctor as unknown as Record<string, unknown>)[key]
        return typeof value === 'function' ? this.staticMethod(key) : value
    }

    /** Declared on the class or one it extends, rather than inherited from `Function`. */
    private isStatic(key: string): boolean {
        if (key === 'prototype') {
            return false
        }
        for (let ctor: unknown = this.ctor; typeof ctor === 'function' && ctor !== Function.prototype; ctor = Object.getPrototypeOf(ctor)) {
            if (Object.hasOwn(ctor, key)) {
                return true
            }
        }
        return false
    }

    /** One per name, so `Class.method == Class.method` in Lua. Called on the class, as JS would. */
    private staticMethod(name: string): AnyFunction {
        let method = this.staticMethods.get(name)
        if (!method) {
            const ctor = this.ctor as unknown as Record<string, AnyFunction>
            method = (...args: any[]) => ctor[name]!(...args)
            this.staticMethods.set(name, method)
        }
        return method
    }
}

/**
 * A class defined through `LuaState.defineClass`. Its instances cross into Lua by reference with a
 * metatable of the class's own, where methods follow Lua's convention and nothing else: the
 * receiver is the first argument, which `object:method(...)` passes.
 */
export default class ClassTypeExtension<T extends object = object> extends TypeExtension<T> {
    public readonly classObject: ClassObjectExtension
    private readonly members: ReadonlySet<string> | undefined
    private readonly methods = new Map<string, AnyFunction>()

    public constructor(
        state: LuaState,
        public readonly ctor: LuaClass<T>,
        options: LuaClassOptions<T> = {},
    ) {
        super(state, classNameOf(ctor, options))
        this.members = options.members && new Set(options.members)

        const { metamethods = {} } = options
        for (const key of RESERVED_METAMETHODS) {
            if (key in metamethods) {
                throw new TypeError(`defineClass cannot replace ${key}`)
            }
        }

        this.defineMetatable({ __newindex: this.set, ...metamethods }, { exclusive: true })
        if (!('__index' in metamethods)) {
            this.installIndex()
        }
        this.classObject = new ClassObjectExtension(state, this.name, ctor, options.statics && new Set(options.statics))
    }

    public push(thread: Thread, instance: T): void {
        this.pushReference(thread, instance)
    }

    private allows(key: string): boolean {
        return this.members === undefined || this.members.has(key)
    }

    private installIndex(): void {
        const { state } = this
        const { module, address: L } = state

        module.luaL_getmetatable(L, this.name)
        state.loadString(INDEX_SOURCE, { name: '=defineClass' })
        state.pushValue(copy(this.collectMethods()))
        state.pushValue(this.get)
        module.lua_callk(L, 2, 1, 0, null)
        module.lua_setfield(L, -2, '__index')
        module.lua_pop(L, 1)
    }

    /** Every method the class and the ones it extends declare, short of `Object`'s own. */
    private collectMethods(): Record<string, AnyFunction> {
        const methods: Record<string, AnyFunction> = Object.create(null)
        const seen = new Set<string>(['constructor'])

        for (
            let proto: object | null = this.ctor.prototype;
            proto !== null && proto !== Object.prototype;
            proto = Object.getPrototypeOf(proto)
        ) {
            for (const key of Object.getOwnPropertyNames(proto)) {
                // Seen even when it turns out to be an accessor, which then shadows a method of
                // the same name further up the chain the way it does in JS.
                if (seen.has(key)) {
                    continue
                }
                seen.add(key)
                if (this.allows(key) && typeof Object.getOwnPropertyDescriptor(proto, key)!.value === 'function') {
                    methods[key] = this.method(key)
                }
            }
        }
        return methods
    }

    /**
     * One per name and shared by every instance, so `a.method == b.method` in Lua. Looked up on
     * the receiver at each call rather than captured here, which is what lets a subclass that was
     * not defined itself still answer with its own override.
     */
    private method(name: string): AnyFunction {
        let method = this.methods.get(name)
        if (!method) {
            const { ctor, name: className } = this
            method = (self: any, ...args: any[]) => {
                if (!(self instanceof ctor)) {
                    throw new TypeError(`bad argument #1 to '${name}' (${className} expected), call it as object:${name}(...)`)
                }
                return (self as Record<string, AnyFunction>)[name]!(...args)
            }
            this.methods.set(name, method)
        }
        return method
    }

    private readonly get = (self: any, key: unknown): unknown => {
        if (typeof key === 'number') {
            return this.members === undefined ? self[toJsIndex(self, key)] : undefined
        }
        if (typeof key !== 'string' || !this.allows(key)) {
            return undefined
        }
        const value = self[key]
        return typeof value === 'function' ? this.method(key) : value
    }

    private readonly set = (self: any, key: unknown, value: unknown): void => {
        if (typeof key === 'number' && this.members === undefined) {
            self[toJsIndex(self, key)] = value
        } else if (typeof key === 'string' && this.allows(key)) {
            self[key] = value
        } else {
            throw new Error(`cannot set '${String(key)}' on a ${this.name}`)
        }
    }
}
