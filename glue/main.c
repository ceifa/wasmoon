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

const char *clua_tostring(lua_State *L, int idx)
{
    return lua_tostring(L, idx);
}

void clua_pop(lua_State *L, int idx)
{
    lua_pop(L, idx);
}

void clua_dump_stack(lua_State *L)
{
    int top = lua_gettop(L);

    for (int i = 1; i <= top; i++)
    {
        printf("%d\t%s\t", i, luaL_typename(L, i));
        switch (lua_type(L, i))
        {
        case LUA_TNUMBER:
            printf("%g\n", lua_tonumber(L, i));
            break;
        case LUA_TSTRING:
            printf("%s\n", lua_tostring(L, i));
            break;
        case LUA_TBOOLEAN:
            printf("%s\n", (lua_toboolean(L, i) ? "true" : "false"));
            break;
        case LUA_TNIL:
            printf("%s\n", "nil");
            break;
        default:
            printf("%p\n", lua_topointer(L, i));
            break;
        }
    }
}