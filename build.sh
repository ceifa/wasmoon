mkdir -p dist

cd lua
make MYLIBS= MYCFLAGS= CC="emcc -O$1 -s WASM=1 -o ../dist/lua.wasm"

cd ..
emcc -Ilua glue/main.c lua/liblua.a \
    -s WASM=1 -O$1 -o dist/glue.js \
    -s EXTRA_EXPORTED_RUNTIME_METHODS="['cwrap', 'addFunction']" \
    -s MODULARIZE=1 \
    -s ALLOW_TABLE_GROWTH \
    -s EXPORT_NAME="initWasmModule" \
    -s EXPORTED_FUNCTIONS="[
        '_luaL_newstate', \
        '_luaL_openlibs', \
        '_clua_dostring', \
        '_lua_getglobal', \
        '_clua_tonumber', \
        '_clua_tostring', \
        '_lua_toboolean', \
        '_lua_gettable', \
        '_lua_next', \
        '_lua_type', \
        '_clua_pop', \
        '_clua_dump_stack', \
        '_lua_topointer', \
        '_lua_pushnil', \
        '_lua_pushvalue', \
        '_lua_pushinteger', \
        '_lua_pushnumber', \
        '_lua_pushstring', \
        '_lua_pushboolean', \
        '_lua_setglobal', \
        '_lua_close' \
    ]"