import type { Decoration } from './decoration'
import type LuaState from './state'
import type Thread from './thread'
import { LUA_REGISTRYINDEX, type LuaGetCache, type LuaPushCache, LuaType } from './types'

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
     * carrying the wrong metatable.
     */
    protected readonly pushedValueCacheReference: number

    public constructor(state: LuaState, name: string) {
        this.state = state
        this.name = name

        const module = state.module
        module.lua_createtable(state.address, 0, 0)
        module.lua_createtable(state.address, 0, 1)
        module.lua_pushstring(state.address, 'v')
        module.lua_setfield(state.address, -2, '__mode')
        module.lua_setmetatable(state.address, -2)
        this.pushedValueCacheReference = module.luaL_ref(state.address, LUA_REGISTRYINDEX)
    }

    public isType(_thread: Thread, _index: number, type: LuaType, name?: string): boolean {
        return type === LuaType.Userdata && name === this.name
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
     * Creates the metatable named after this extension: protected from `getmetatable` and
     * `setmetatable` in Lua, with the `__gc` that releases the reference a box pushed by
     * {@link pushReference} holds, and with each of `metamethods` set on it. A metamethod is pushed
     * the way any value is, so a function becomes a Lua function and a plain object a table -- by
     * way of the extensions registered so far, which is why the built-ins register in dependency
     * order.
     *
     * Only fills a metatable it created. A second extension registered under the same name on the
     * same state finds the first one's and leaves it alone.
     */
    protected defineMetatable(metamethods: Record<string, unknown> = {}): void {
        const state = this.state
        const module = state.module
        const L = state.address

        if (module.luaL_newmetatable(L, this.name)) {
            const metatableIndex = module.lua_gettop(L)

            module.lua_pushstring(L, 'protected metatable')
            module.lua_setfield(L, metatableIndex, '__metatable')

            module.lua_pushcclosure(L, module.referenceGcFunction(), 0)
            module.lua_setfield(L, metatableIndex, '__gc')

            for (const key in metamethods) {
                state.pushValue(metamethods[key])
                module.lua_setfield(L, metatableIndex, key)
            }
        }
        // Whether created here or found, the metatable is on the stack.
        module.lua_pop(L, 1)
    }

    // A base implementation that assumes user data serialisation
    public getValue(thread: Thread, index: number, _cache?: LuaGetCache): T {
        const value = thread.module.getReferenceBox(thread.address, index, this.name)
        if (value === undefined) {
            throw new Error(`data does not have the expected metatable: ${this.name}`)
        }
        return value as T
    }

    // Return false if type not matched, otherwise true. This base method does not
    // check the type. That must be done by the class extending this.
    public pushValue(thread: Thread, decoratedValue: Decoration<unknown>, _cache?: LuaPushCache): boolean {
        this.pushReference(thread, decoratedValue.target)
        return true
    }

    /**
     * Pushes `referent` boxed in a userdata carrying this extension's metatable -- or, if Lua still
     * holds the value pushed for it before, that same value, so a JS value pushed twice is one value
     * in Lua. With `closure`, a C function pointer, what is pushed and cached is instead a closure
     * over the box, which it sees as its first upvalue.
     */
    protected pushReference(thread: Thread, referent: unknown, closure?: number): void {
        const module = thread.module
        const L = thread.address
        const cachedType = closure === undefined ? LuaType.Userdata : LuaType.Function

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

        if (closure !== undefined) {
            // Pops the box and pushes the closure holding it as an upvalue.
            module.lua_pushcclosure(L, closure, 1)
        }

        // Remember the value for the next push of the same referent, then drop the cache table
        // from under it. Weak, so this never outlives the value: once Lua collects it the box goes
        // too, and its __gc releases the reference.
        module.lua_pushvalue(L, -1)
        module.lua_rawseti(L, -3, pointer)
        module.lua_remove(L, -2)
    }
}
