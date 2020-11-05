#include <stdio.h>
#include "lua.h"
#include <lauxlib.h>

int clua_dostring(lua_State *L, const char *script)
{
    return luaL_dostring(L, script);
}

void clua_register(lua_State *L, const char *name, int (*func)(lua_State *L))
{
    lua_register(L, name, func);
}

double clua_tonumber(lua_State *L, int idx)
{
    return lua_tonumber(L, idx);
}