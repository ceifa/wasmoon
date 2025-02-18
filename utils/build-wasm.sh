#!/bin/bash -e
cd $(dirname $0)
mkdir -p ../build

LUA_SRC=$(ls ../lua/*.c | grep -v "luac.c" | grep -v "lua.c" | tr "\n" " ")

extension=""
if [ "$1" == "dev" ];
then
    extension="-O0 -g3 -s ASSERTIONS=1 -s SAFE_HEAP=1 -s STACK_OVERFLOW_CHECK=2"
else
    extension="-O3"
fi

emcc \
    -lnodefs.js \
    -s WASM=1 $extension -o ../build/glue.js \
    -s EXPORTED_RUNTIME_METHODS="[
        'ccall', \
        'addFunction', \
        'removeFunction', \
        'FS', \
        'ENV', \
        'getValue', \
        'setValue', \
        'lengthBytesUTF8', \
        'stringToUTF8', \
        'stringToNewUTF8', \
        'UTF8ToString', \
        'HEAPU32'
    ]" \
    -s INCOMING_MODULE_JS_API="[
        'locateFile', \
        'preRun'
    ]" \
    -s ENVIRONMENT="web,worker,node" \
    -s MODULARIZE=1 \
    -s ALLOW_TABLE_GROWTH=1 \
    -s EXPORT_NAME="initWasmModule" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s STRICT=1 \
    -s EXPORT_ES6=1 \
    -s NODEJS_CATCH_EXIT=0 \
    -s NODEJS_CATCH_REJECTION=0 \
    -s MALLOC=emmalloc \
    -s STACK_SIZE=1MB \
    -s WASM_BIGINT \
    -s EXPORTED_FUNCTIONS="[
        '_malloc', \
        '_free', \
        '_realloc', \
        '_luaL_checkversion_', \
        '_luaL_getmetafield', \
        '_luaL_callmeta', \
        '_luaL_tolstring', \
        '_luaL_argerror', \
        '_luaL_typeerror', \
        '_luaL_checklstring', \
        '_luaL_optlstring', \
        '_luaL_checknumber', \
        '_luaL_optnumber', \
        '_luaL_checkinteger', \
        '_luaL_optinteger', \
        '_luaL_checkstack', \
        '_luaL_checktype', \
        '_luaL_checkany', \
        '_luaL_newmetatable', \
        '_luaL_setmetatable', \
        '_luaL_testudata', \
        '_luaL_checkudata', \
        '_luaL_where', \
        '_luaL_fileresult', \
        '_luaL_execresult', \
        '_luaL_ref', \
        '_luaL_unref', \
        '_luaL_loadfilex', \
        '_luaL_loadbufferx', \
        '_luaL_loadstring', \
        '_luaL_newstate', \
        '_luaL_len', \
        '_luaL_addgsub', \
        '_luaL_gsub', \
        '_luaL_setfuncs', \
        '_luaL_getsubtable', \
        '_luaL_traceback', \
        '_luaL_requiref', \
        '_luaL_buffinit', \
        '_luaL_prepbuffsize', \
        '_luaL_addlstring', \
        '_luaL_addstring', \
        '_luaL_addvalue', \
        '_luaL_pushresult', \
        '_luaL_pushresultsize', \
        '_luaL_buffinitsize', \
        '_lua_newstate', \
        '_lua_close', \
        '_lua_newthread', \
        '_lua_resetthread', \
        '_lua_atpanic', \
        '_lua_version', \
        '_lua_absindex', \
        '_lua_gettop', \
        '_lua_settop', \
        '_lua_pushvalue', \
        '_lua_rotate', \
        '_lua_copy', \
        '_lua_checkstack', \
        '_lua_xmove', \
        '_lua_isnumber', \
        '_lua_isstring', \
        '_lua_iscfunction', \
        '_lua_isinteger', \
        '_lua_isuserdata', \
        '_lua_type', \
        '_lua_typename', \
        '_lua_tonumberx', \
        '_lua_tointegerx', \
        '_lua_toboolean', \
        '_lua_tolstring', \
        '_lua_rawlen', \
        '_lua_tocfunction', \
        '_lua_touserdata', \
        '_lua_tothread', \
        '_lua_topointer', \
        '_lua_arith', \
        '_lua_rawequal', \
        '_lua_compare', \
        '_lua_pushnil', \
        '_lua_pushnumber', \
        '_lua_pushinteger', \
        '_lua_pushlstring', \
        '_lua_pushstring', \
        '_lua_pushcclosure', \
        '_lua_pushboolean', \
        '_lua_pushlightuserdata', \
        '_lua_pushthread', \
        '_lua_getglobal', \
        '_lua_gettable', \
        '_lua_getfield', \
        '_lua_geti', \
        '_lua_rawget', \
        '_lua_rawgeti', \
        '_lua_rawgetp', \
        '_lua_createtable', \
        '_lua_newuserdatauv', \
        '_lua_getmetatable', \
        '_lua_getiuservalue', \
        '_lua_setglobal', \
        '_lua_settable', \
        '_lua_setfield', \
        '_lua_seti', \
        '_lua_rawset', \
        '_lua_rawseti', \
        '_lua_rawsetp', \
        '_lua_setmetatable', \
        '_lua_setiuservalue', \
        '_lua_callk', \
        '_lua_pcallk', \
        '_lua_load', \
        '_lua_dump', \
        '_lua_yieldk', \
        '_lua_resume', \
        '_lua_status', \
        '_lua_isyieldable', \
        '_lua_setwarnf', \
        '_lua_warning', \
        '_lua_error', \
        '_lua_next', \
        '_lua_concat', \
        '_lua_len', \
        '_lua_stringtonumber', \
        '_lua_getallocf', \
        '_lua_setallocf', \
        '_lua_toclose', \
        '_lua_closeslot', \
        '_lua_getstack', \
        '_lua_getinfo', \
        '_lua_getlocal', \
        '_lua_setlocal', \
        '_lua_getupvalue', \
        '_lua_setupvalue', \
        '_lua_upvalueid', \
        '_lua_upvaluejoin', \
        '_lua_sethook', \
        '_lua_gethook', \
        '_lua_gethookmask', \
        '_lua_gethookcount', \
        '_lua_setcstacklimit', \
        '_luaopen_base', \
        '_luaopen_coroutine', \
        '_luaopen_table', \
        '_luaopen_io', \
        '_luaopen_os', \
        '_luaopen_string', \
        '_luaopen_utf8', \
        '_luaopen_math', \
        '_luaopen_debug', \
        '_luaopen_package', \
        '_luaL_openlibs' \
    ]" \
    ${LUA_SRC}
