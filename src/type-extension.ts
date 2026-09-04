import type { Decoration } from './decoration'
import type LuaState from './state'
import type Thread from './thread'
import { LUA_REGISTRYINDEX, type LuaAddress, type LuaGetCache, type LuaPushCache, LuaReturn, LuaType, PointerSize } from './types'

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
    protected readonly pushedValueCacheReference: bigint

    public constructor(state: LuaState, name: string) {
        this.state = state
        this.name = name

        const module = state.module
        module.lua_createtable(state.address, 0, 0)
        module.lua_createtable(state.address, 0, 1)
        module.lua_pushstring(state.address, 'v')
        module.lua_setfield(state.address, -2, '__mode')
        module.lua_setmetatable(state.address, -2)
        this.pushedValueCacheReference = BigInt(module.luaL_ref(state.address, LUA_REGISTRYINDEX))
    }

    public isType(_thread: Thread, _index: number, type: LuaType, name?: string): boolean {
        return type === LuaType.Userdata && name === this.name
    }

    /**
     * Releases what the extension owns outside Lua: the function pointers it took from
     * `addFunction`, and any JS side bookkeeping.
     *
     * Called only from {@link LuaState.close}, and only after `lua_close` has already run every
     * `__gc` handler and freed the state along with its registry and every thread anchored there.
     * So the pointers are still valid here and the `__gc` handlers still needed them a moment ago,
     * but nothing may touch the state itself -- unreffing a registry slot or calling into a thread
     * at this point is a use after free.
     */
    public abstract close(): void

    /**
     * The `__gc` handler every reference holding extension needs. The caller owns the returned
     * pointer and has to release it with the module's `removeFunction` in {@link close}.
     */
    protected createGcFunction(): number {
        return this.state.module.addFunction((calledL: LuaAddress) => {
            // Throws a lua error which does a jump if it does not match.
            const userDataPointer = this.state.module.luaL_checkudata(calledL, 1, this.name)
            const referencePointer = this.state.module.readPointer(userDataPointer)
            this.state.module.unref(referencePointer)

            return LuaReturn.Ok
        }, 'ii')
    }

    // A base implementation that assumes user data serialisation
    public getValue(thread: Thread, index: number, _cache?: LuaGetCache): T {
        const refUserdata = thread.module.luaL_testudata(thread.address, index, this.name)
        if (!refUserdata) {
            throw new Error(`data does not have the expected metatable: ${this.name}`)
        }
        const referencePointer = thread.module.readPointer(refUserdata)
        return thread.module.getRef(referencePointer) as T
    }

    // Return false if type not matched, otherwise true. This base method does not
    // check the type. That must be done by the class extending this.
    public pushValue(thread: Thread, decoratedValue: Decoration<unknown>, _cache?: LuaPushCache): boolean {
        const { target } = decoratedValue
        const module = thread.module

        // The cache table stays at the bottom for the whole push, so the probe and the store
        // below share the one registry fetch.
        module.lua_rawgeti(thread.address, LUA_REGISTRYINDEX, this.pushedValueCacheReference)

        const existingIndex = module.getRefIndex(target)
        if (existingIndex !== undefined) {
            if (module.lua_rawgeti(thread.address, -1, BigInt(existingIndex)) === LuaType.Userdata) {
                // Drop the cache table, keeping the userdata.
                module.lua_remove(thread.address, -2)
                return true
            }
            // Pop the miss; the cache table stays for the store.
            thread.pop(1)
        }

        const pointer = module.ref(target)
        // 4 = size of pointer in wasm.
        const userDataPointer = module.lua_newuserdatauv(thread.address, PointerSize, 0)
        module.writePointer(userDataPointer, pointer)

        if (LuaType.Nil === module.luaL_getmetatable(thread.address, this.name)) {
            // Pop the pushed nil value, the user data and the cache table. The reference has to be
            // released by hand: without a metatable the userdata has no __gc, so nothing else ever
            // would.
            thread.pop(3)
            module.unref(pointer)
            throw new Error(`metatable not found: ${this.name}`)
        }

        // Set as the metatable for the userdata.
        // -1 is the metatable, -2 is the user data.
        module.lua_setmetatable(thread.address, -2)

        // Remember the userdata for the next push of the same value, then drop the cache table
        // from under it.
        module.lua_pushvalue(thread.address, -1)
        module.lua_rawseti(thread.address, -3, BigInt(pointer))
        module.lua_remove(thread.address, -2)

        return true
    }
}
