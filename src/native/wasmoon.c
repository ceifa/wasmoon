#include "lua.h"

/*
 * Twins of the lua_Integer entry points that take a double where the originals take a 64 bit
 * integer. lua_Integer crosses the wasm boundary as a BigInt, so pushing a plain JS number would
 * otherwise convert to BigInt on every call; these let a number that is a safe integer skip that.
 */

void wasmoon_pushinteger(lua_State *L, double n) {
    lua_pushinteger(L, (lua_Integer)n);
}

int wasmoon_geti(lua_State *L, int idx, double n) {
    return lua_geti(L, idx, (lua_Integer)n);
}

int wasmoon_rawgeti(lua_State *L, int idx, double n) {
    return lua_rawgeti(L, idx, (lua_Integer)n);
}

void wasmoon_seti(lua_State *L, int idx, double n) {
    lua_seti(L, idx, (lua_Integer)n);
}

void wasmoon_rawseti(lua_State *L, int idx, double n) {
    lua_rawseti(L, idx, (lua_Integer)n);
}

/*
 * The closure every JS function is pushed as. Its first upvalue is the reference box the function
 * extension reads; its second is the call hook, a lua_CFunction stored as light userdata.
 *
 * The call hook runs the JS function. When it returns -1 the JS side has stashed a promise and
 * asked to suspend, and the await hook is reached from this wasm frame with no JS frame in between,
 * which is what the JSPI engine needs to switch the stack. The await hook is a plain never
 * suspending stub under the fallback engine, where the call hook never returns -1.
 */

static lua_CFunction await_hook;

static int wasmoon_jsfunction(lua_State *L) {
    lua_CFunction call_hook = (lua_CFunction)lua_touserdata(L, lua_upvalueindex(2));
    int n = call_hook(L);
    if (n == -1) {
        n = await_hook(L);
    }
    return n;
}

void wasmoon_set_await_hook(lua_CFunction hook) {
    await_hook = hook;
}

/* Pops the reference box already on the stack and pushes the closure over it and call_hook. */
void wasmoon_push_jsfunction(lua_State *L, lua_CFunction call_hook) {
    lua_pushlightuserdata(L, (void *)call_hook);
    lua_pushcclosure(L, wasmoon_jsfunction, 2);
}
