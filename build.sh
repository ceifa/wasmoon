#!/bin/bash -e

mkdir -p build

LUA_SRC=$(ls ./lua/*.c | grep -v "luac.c" | grep -v "lua.c" | tr "\n" " ")

extension=$1
if [ "$extension" == "3" ];
then
    extension="$extension --closure 1"
elif [ "$extension" == "3" ];
then
    extension="$extension -s ASSERTIONS=1"
fi

emcc \
    -s WASM=1 -O$1 -o ./build/glue.js \
    -s EXTRA_EXPORTED_RUNTIME_METHODS="['cwrap', 'addFunction', 'removeFunction', 'FS', 'getValue', 'setValue']" \
    -s MODULARIZE=1 \
    -s ALLOW_TABLE_GROWTH \
    -s EXPORT_NAME="initWasmModule" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s STRICT=1 \
    -s EXPORT_ES6=1 \
    -s MALLOC=emmalloc \
    -s EXPORTED_FUNCTIONS="[
        '_malloc', \
        '_free', \
        '_luaL_newstate', \
        '_luaL_openlibs', \
        '_luaL_loadstring', \
        '_luaL_loadfilex', \
        '_lua_getglobal', \
        '_lua_tonumberx', \
        '_lua_tolstring', \
        '_lua_toboolean', \
        '_lua_topointer', \
        '_lua_tothread', \
        '_lua_newthread', \
        '_lua_resetthread', \
        '_lua_gettable', \
        '_lua_next', \
        '_lua_type', \
        '_lua_settop', \
        '_lua_pushnil', \
        '_lua_pushvalue', \
        '_lua_pushinteger', \
        '_lua_pushnumber', \
        '_lua_pushstring', \
        '_lua_pushboolean', \
        '_lua_pushthread', \
        '_lua_setglobal', \
        '_lua_setmetatable', \
        '_lua_createtable', \
        '_lua_gettop', \
        '_lua_settable', \
        '_lua_callk', \
        '_lua_pcallk', \
        '_lua_yieldk', \
        '_lua_resume', \
        '_lua_pushcclosure', \
        '_lua_getfield', \
        '_luaL_newmetatable', \
        '_lua_newuserdatauv', \
        '_luaL_checkudata', \
        '_luaL_testudata', \
        '_luaL_ref', \
        '_luaL_unref', \
        '_lua_rawgeti', \
        '_lua_typename', \
        '_lua_close' \
    ]" \
    ${LUA_SRC}
