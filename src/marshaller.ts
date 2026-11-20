import { LuaMarshalled } from './marshal'
import type Thread from './thread'
import type LuaTypeExtension from './type-extension'
import type ClassTypeExtension from './type-extensions/class'
import type DefinedTypeExtension from './type-extensions/defined'
import type { ErrorTypeExtension } from './type-extensions/error'
import type { FunctionTypeExtension } from './type-extensions/function'
import type { NullTypeExtension } from './type-extensions/null'
import type { PromiseTypeExtension } from './type-extensions/promise'
import type { ProxyTypeExtension } from './type-extensions/proxy'
import type { TableTypeExtension } from './type-extensions/table'
import type { UserdataTypeExtension } from './type-extensions/userdata'
import { type LuaAddress, type LuaGetCache, type LuaPushCache, LuaType } from './types'
import { isPromise } from './utils'

/**
 * Decides how each value crosses between JS and Lua for one state, and is shared by every thread
 * on it. The order is the whole rule, top to bottom:
 *
 * 1. A value wrapped by `copy`, `proxy`, `opaque` or `raw` crosses the way the wrapper says.
 * 2. A type defined with `defineType` takes what it matches, the most recently defined first.
 * 3. A class defined with `defineClass` takes its instances, the most derived class first, and
 *    itself.
 * 4. Everything else goes by what it is: `null`, a function, a promise, an `Error`, and lastly
 *    any other object, which is proxied or copied as the state's `objects` option says.
 */
export default class Marshaller {
    /** What an object nothing above claimed is pushed as. */
    public objects: 'proxy' | 'copy' = 'proxy'

    public functions!: FunctionTypeExtension
    public tables!: TableTypeExtension
    public proxies!: ProxyTypeExtension
    public promises!: PromiseTypeExtension
    public errors!: ErrorTypeExtension
    public opaques!: UserdataTypeExtension
    /** Only when the state injects `null`; without it a JS null is a Lua nil. */
    public nulls: NullTypeExtension | undefined

    /**
     * The extension behind each metatable this state created, keyed by the metatable's address.
     * Those metatables are registry anchored for the state's whole life, so an address in here
     * can never be reused by anything else while the map exists -- and going by the address rather
     * than by `__name` means nothing a script writes into a metatable of its own can pass a value
     * off as a reference box.
     */
    public readonly owners = new Map<LuaAddress, LuaTypeExtension<unknown>>()
    /** Every extension's name, taken from the moment it is created. */
    public readonly names = new Set<string>()
    private readonly extensions: LuaTypeExtension<unknown>[] = []

    private readonly types: DefinedTypeExtension[] = []
    /** The defined types that also read Lua tables whose own metatable carries their `__name`. */
    private readonly typesByName = new Map<string, DefinedTypeExtension>()
    private readonly classesByPrototype = new Map<object, ClassTypeExtension>()
    private readonly classesByConstructor = new Map<unknown, ClassTypeExtension>()

    public addType(type: DefinedTypeExtension): void {
        // Most recent first, so a later definition can take a narrower slice of an earlier one.
        this.types.unshift(type)
        if (type.readsByName) {
            this.typesByName.set(type.name, type)
        }
    }

    public hasClass(ctor: unknown): boolean {
        return this.classesByConstructor.has(ctor)
    }

    public addClass(type: ClassTypeExtension): void {
        this.classesByPrototype.set(type.ctor.prototype, type)
        this.classesByConstructor.set(type.ctor, type)
    }

    /** Pushes anything that is not a primitive: an object, a function, or null. */
    public push(thread: Thread, value: unknown, cache?: LuaPushCache): void {
        if (value === null) {
            if (this.nulls) {
                this.nulls.push(thread)
            } else {
                thread.module.lua_pushnil(thread.address)
            }
            return
        }

        if (value instanceof LuaMarshalled) {
            this.pushMarshalled(thread, value, cache)
            return
        }

        const types = this.types
        for (let i = 0; i < types.length; i++) {
            if (types[i]!.push(thread, value, cache)) {
                return
            }
        }

        if (typeof value === 'function') {
            const type = this.classesByConstructor.size === 0 ? undefined : this.classesByConstructor.get(value)
            if (type) {
                type.classObject.push(thread)
            } else {
                this.functions.push(thread, value as (...args: any[]) => unknown)
            }
            return
        }

        if (typeof value !== 'object') {
            throw new Error(`The type '${typeof value}' is not supported by Lua`)
        }

        if (this.classesByPrototype.size !== 0) {
            for (let proto = Object.getPrototypeOf(value); proto !== null; proto = Object.getPrototypeOf(proto)) {
                const type = this.classesByPrototype.get(proto)
                if (type) {
                    type.push(thread, value)
                    return
                }
            }
        }

        if (isPromise(value)) {
            this.promises.push(thread, value)
        } else if (value instanceof Error) {
            this.errors.push(thread, value)
        } else if (cache !== undefined || this.objects === 'copy') {
            // A cache means this is a value inside a table being copied, and a copy is a deep one.
            this.tables.push(thread, value, cache)
        } else {
            this.proxies.push(thread, value)
        }
    }

    /** Reads a table, a userdata or a function. */
    public get(thread: Thread, index: number, type: LuaType, cache?: LuaGetCache): unknown {
        if (type === LuaType.Function) {
            return this.functions.getValue(thread, index)
        }

        if (type === LuaType.Table || type === LuaType.Userdata) {
            const { module, address: L } = thread
            if (module.lua_getmetatable(L, index)) {
                let owner: LuaTypeExtension<unknown> | undefined = this.owners.get(module.lua_topointer(L, -1))
                // Only a table, whose content is all the type gets to see: a reference box is
                // recognised by its metatable's address and by nothing a script can write.
                if (owner === undefined && type === LuaType.Table && this.typesByName.size !== 0) {
                    if (module.lua_getfield(L, -1, '__name') === LuaType.String) {
                        owner = this.typesByName.get(module.lua_tolstring(L, -1, null))
                    }
                    module.lua_pop(L, 1)
                }
                module.lua_pop(L, 1)
                if (owner !== undefined) {
                    return owner.getValue(thread, index, cache)
                }
            }
            if (type === LuaType.Table) {
                return this.tables.getValue(thread, index, cache)
            }
        }

        // Handing back an opaque Pointer hid the failure until the value was used, and
        // it could not be pushed back into Lua anyway.
        const typeName = thread.module.lua_typename(thread.address, type)
        const metatableName = type === LuaType.Userdata ? thread.getMetatableName(index) : undefined
        const withMetatable = metatableName ? ` with metatable '${metatableName}'` : ''
        throw new TypeError(
            `the Lua type '${typeName}'${withMetatable} has no JS representation; define a type to handle it, ` +
                `or read the address with getPointer`,
        )
    }

    /**
     * Releases what the extensions own outside Lua. See `LuaTypeExtension.close` for when this may
     * run and what it may touch.
     */
    public close(): void {
        for (const extension of this.extensions) {
            extension.close()
        }
    }

    /** Called by every extension as it is created, so that {@link close} reaches it. */
    public track(extension: LuaTypeExtension<unknown>): void {
        this.extensions.push(extension)
    }

    private pushMarshalled(thread: Thread, wrapped: LuaMarshalled, cache: LuaPushCache | undefined): void {
        const { target } = wrapped
        // A wrapper says how an object or a function crosses. A primitive has only one way.
        if (target === null || (typeof target !== 'object' && typeof target !== 'function')) {
            thread.pushValue(target)
            return
        }

        switch (wrapped.as) {
            case 'opaque':
                this.opaques.push(thread, target)
                break
            case 'proxy':
                this.proxies.push(thread, target)
                break
            case 'raw':
                this.functions.push(thread, wrapped as LuaMarshalled<(...args: any[]) => unknown>)
                break
            case 'method':
                this.proxies.push(thread, wrapped)
                break
            case 'copy':
                if (typeof target === 'function') {
                    this.functions.push(thread, target as (...args: any[]) => unknown)
                } else {
                    this.tables.push(thread, target, cache)
                }
                if (wrapped.metatable) {
                    thread.setMetatable(-1, wrapped.metatable)
                }
                break
        }
    }
}
