# TODO: Make optimization level parameterized

mkdir -p dist

cd lua
make MYLIBS= MYCFLAGS= CC='emcc -s WASM=1 -o ../dist/lua.wasm'

cd ..
emcc -Ilua glue/main.c lua/liblua.a \
    -s WASM=1 -O0 -o dist/glue.js \
    -s EXTRA_EXPORTED_RUNTIME_METHODS="['cwrap', 'addFunction']" \
    -s MODULARIZE=1 \
    -s ALLOW_TABLE_GROWTH \
    -s 'EXPORT_NAME="initWasmModule"' \
    -s EXPORTED_FUNCTIONS="[
        '_luaL_newstate', \
        '_luaL_openlibs', \
        '_clua_dostring', \
        '_lua_getglobal', \
        '_clua_tonumber', \
        '_lua_close' \
    ]"