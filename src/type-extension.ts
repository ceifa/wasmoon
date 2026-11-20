import { copy, LuaMarshalled } from './marshal'
import type LuaState from './state'
import type Thread from './thread'
import { type LuaAddress, LUA_REGISTRYINDEX, type LuaGetCache, LuaType } from './types'

export interface MetatableOptions {
    /** Fail when the name is taken rather than leave the existing metatable alone. */
    exclusive?: boolean
    /**
     * False for a metatable that goes on Lua tables rather than on reference boxes: it gets
     * neither the `__gc` that releases a reference nor the protection from `getmetatable`.
     */
    boxed?: boolean
}

/**
 * One way a kind of value crosses between JS and Lua, and the owner of the metatable that marks
 * it on the Lua side. The state consults these in a fixed order (see `Marshaller`); what a caller
 * adds goes through `LuaState.defineType` and `LuaState.defineClass`.
 */
export default abstract class LuaTypeExtension<T> {
    // Type name, for metatables and lookups.
    public readonly name: string
    /** Owns this extension's metatable and function pointers, so its lifetime bounds theirs. */
    protected state: LuaState
    /**
     * A weak valued table in the registry mapping a reference index to the Lua value pushed for it
     * (the userdata here, the closure over it in the function extension), so pushing the same value
     * again returns that one instead of allocating another -- which also gives it a stable identity
     * in Lua. Weak, so the cache never keeps a Lua value alive: an entry goes as soon as Lua drops
     * the value, before the userdata's `__gc` releases the reference index it is keyed by. Per
     * extension, because the same value pushed through two extensions must not share a userdata
     * carrying the wrong metatable. Created on first use: table copies never use this cache,
     * and states need not allocate caches for reference types they never push.
     */
    private cacheReference = 0
    private deferredMetamethods: (() => Record<string, unknown>) | undefined

    public constructor(state: LuaState, name: string) {
        // Ahead of the registry, which only learns of a name once its metatable exists.
        const { names } = state.marshaller
        if (names.has(name)) {
            throw new Error(`the name '${name}' is already taken in this state`)
        }
        names.add(name)
        state.marshaller.track(this as LuaTypeExtension<unknown>)

        this.state = state
        this.name = name
    }

    protected get pushedValueCacheReference(): number {
        if (!this.cacheReference) {
            const { module, address } = this.state
            module.lua_createtable(address, 0, 0)
            module.lua_createtable(address, 0, 1)
            module.lua_pushstring(address, 'v')
            module.lua_setfield(address, -2, '__mode')
            module.lua_setmetatable(address, -2)
            this.cacheReference = module.luaL_ref(address, LUA_REGISTRYINDEX)
        }
        return this.cacheReference
    }

    /**
     * Releases what the extension owns outside Lua: function pointers it took from `addFunction`,
     * and any JS side bookkeeping. Nothing, for an extension that has no more than
     * {@link defineMetatable} gives it; one that owns more overrides this and calls `super.close()`.
     *
     * Called only from {@link LuaState.close}, and only after `lua_close` has already run every
     * `__gc` handler and freed the state along with its registry and every thread anchored there.
     * So the pointers are still valid here and the `__gc` handlers still needed them a moment ago,
     * but nothing may touch the state itself -- unreffing a registry slot or calling into a thread
     * at this point is a use after free.
     */
    public close(): void {
        // The __gc handler belongs to the module, so there is nothing of the base's to release.
    }

    /**
     * Creates the metatable named after this extension and records this extension as its owner,
     * which is what a read recognises a value of this type by. A boxed one (the default) is
     * protected from `getmetatable` and `setmetatable` in Lua and carries the `__gc` that releases
     * the reference a box pushed by {@link pushReference} holds. Each of `metamethods` is set on it,
     * pushed the way any value is, except that a plain object is copied into a table whatever the
     * state's `objects` option says.
     *
     * Only fills a metatable it created. A second extension under the same name on the same state
     * finds the first one's and leaves it alone, unless it asked to be `exclusive`.
     */
    protected defineMetatable(metamethods: Record<string, unknown> = {}, { exclusive = false, boxed = true }: MetatableOptions = {}): void {
        const state = this.state
        const module = state.module
        const L = state.address

        if (module.luaL_newmetatable(L, this.name)) {
            const metatableIndex = module.lua_gettop(L)
            state.marshaller.owners.set(module.lua_topointer(L, metatableIndex), this)

            if (boxed) {
                module.lua_pushstring(L, 'protected metatable')
                module.lua_setfield(L, metatableIndex, '__metatable')

                module.lua_pushcclosure(L, module.referenceGcFunction(), 0)
                module.lua_setfield(L, metatableIndex, '__gc')
            }

            for (const key in metamethods) {
                const value = metamethods[key]
                state.pushValue(typeof value === 'object' && value !== null && !(value instanceof LuaMarshalled) ? copy(value) : value)
                module.lua_setfield(L, metatableIndex, key)
            }
        } else if (exclusive) {
            module.lua_pop(L, 1)
            throw new Error(`the name '${this.name}' is already taken in this state`)
        }
        // Whether created here or found, the metatable is on the stack.
        module.lua_pop(L, 1)
    }

    /**
     * {@link defineMetatable}, put off until the first value of this type is pushed: building a
     * metatable is most of what an extension costs, and a state pays it for every one it creates.
     */
    protected deferMetatable(metamethods: () => Record<string, unknown>): void {
        this.deferredMetamethods = metamethods
    }

    /**
     * The JS value of the Lua value at `index`, which the caller has already established to carry
     * this extension's metatable. This base reads a reference box.
     */
    public getValue(thread: Thread, index: number, _cache?: LuaGetCache): T {
        return thread.module.getReferenceBox(thread.address, index) as T
    }

    /**
     * Pushes `referent` boxed in a userdata carrying this extension's metatable -- or, if Lua still
     * holds the value pushed for it before, that same value, so a JS value pushed twice is one value
     * in Lua. With `closure`, a C function pointer, what is pushed and cached is instead a closure
     * over the box, which it sees as its first upvalue.
     */
    protected pushReference(thread: Thread, referent: unknown, wrapClosure?: (L: LuaAddress) => void): void {
        if (this.deferredMetamethods !== undefined) {
            const metamethods = this.deferredMetamethods
            this.deferredMetamethods = undefined
            this.defineMetatable(metamethods())
        }

        const module = thread.module
        const L = thread.address
        const cachedType = wrapClosure === undefined ? LuaType.Userdata : LuaType.Function

        // The cache table stays at the bottom for the whole push, so the probe and the store
        // below share the one registry fetch.
        module.lua_rawgeti(L, LUA_REGISTRYINDEX, this.pushedValueCacheReference)

        const existingIndex = module.getRefIndex(referent)
        if (existingIndex !== undefined) {
            if (module.lua_rawgeti(L, -1, existingIndex) === cachedType) {
                // Drop the cache table, keeping the value.
                module.lua_remove(L, -2)
                return
            }
            // Pop the miss; the cache table stays for the store.
            thread.pop(1)
        }

        const pointer = module.pushReferenceBox(L, referent)

        if (LuaType.Nil === module.luaL_getmetatable(L, this.name)) {
            // Pop the pushed nil value, the box and the cache table. The reference has to be
            // released by hand: without a metatable the box has no __gc, so nothing else ever would.
            thread.pop(3)
            module.unref(pointer)
            throw new Error(`metatable not found: ${this.name}`)
        }

        // -1 is the metatable, -2 is the box.
        module.lua_setmetatable(L, -2)

        if (wrapClosure !== undefined) {
            wrapClosure(L)
        }

        // Remember the value for the next push of the same referent, then drop the cache table
        // from under it. Weak, so this never outlives the value: once Lua collects it the box goes
        // too, and its __gc releases the reference.
        module.lua_pushvalue(L, -1)
        module.lua_rawseti(L, -3, pointer)
        module.lua_remove(L, -2)
    }
}
