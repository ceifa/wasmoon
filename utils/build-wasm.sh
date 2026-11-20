#!/bin/bash -e
cd $(dirname $0)
mkdir -p ../build/host

LUA_SRC="$(ls ../lua/*.c | grep -v "luac.c" | grep -v "lua.c" | tr "\n" " ") ../src/native/wasmoon.c"

if [ "$1" == "dev" ];
then
    extension=(-O0 -g3 -s ASSERTIONS=1 -s SAFE_HEAP=1 -s STACK_OVERFLOW_CHECK=2)
else
    extension=(-Oz -DLUA_USE_JUMPTABLE=0 -s BINARYEN_EXTRA_PASSES=gufa-optimizing,converge)
fi

# Everything that is not about the filesystem, shared by both glues below so they can share one
# `glue.wasm`.
COMMON=(
    -s WASM=1
    -s SUPPORT_LONGJMP=wasm
    -I../lua
    "${extension[@]}"
    -s EXPORTED_RUNTIME_METHODS="[
        'addFunction', \
        'removeFunction', \
        'FS', \
        'NODEFS', \
        'PATH', \
        'ENV', \
        'getValue', \
        'setValue', \
        'lengthBytesUTF8', \
        'stringToUTF8', \
        'stringToNewUTF8', \
        'stringToUTF8OnStack', \
        'stackSave', \
        'stackRestore', \
        'UTF8ToString', \
        'HEAPU8', \
        'HEAPU32'
    ]"
    -s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE="[
        '\$FS_mkdirTree', \
        '\$PATH', \
        '\$PATH_FS'
    ]"
    -s INCOMING_MODULE_JS_API="[
        'locateFile', \
        'preRun', \
        'print', \
        'printErr' \
    ]"
    -s MODULARIZE=1
    -s ALLOW_TABLE_GROWTH=1
    -s EXPORT_NAME="initWasmModule"
    -s ALLOW_MEMORY_GROWTH=1
    -s STRICT=1
    -s EXPORT_ES6=1
    -s MALLOC=emmalloc
    -s STACK_SIZE=1MB
    # The heap starts small and grows on demand (ALLOW_MEMORY_GROWTH below): a fresh state is
    # around 20 KB and a hello world never grows, while the 16 MB default was almost entirely
    # untouched address space that every heap snapshot and memory profile still counted.
    # Growing is cheap here (twelve 20% steps from 2 to 18 MB measure well under a millisecond),
    # and the JS side never caches a heap view across a call that can grow it.
    -s INITIAL_HEAP=1MB
    # The engines package.json promises, so the glue carries no fallbacks for older ones. The browser
    # minimums go on the web glue alone below: the host glue is Node only and would warn about them.
    -s MIN_NODE_VERSION=260000
    # The Lua C API and the functions of src/native/wasmoon.c, as listed by create-bindings.js from
    # the headers. build-wasm.js runs it ahead of this script.
    -s EXPORTED_FUNCTIONS=@../build/exported-functions.json
)

# The default glue, for every environment. Its filesystem is Emscripten's in-memory one, and
# -lnodefs.js adds the NODEFS backend so a host directory can be mounted into it (LuaModuleOptions
# `mounts`). Nothing here reaches the host on its own.
emcc "${COMMON[@]}" \
    -lnodefs.js \
    -s ENVIRONMENT="web,worker,node" \
    -s MIN_CHROME_VERSION=134 \
    -s MIN_FIREFOX_VERSION=138 \
    -s MIN_SAFARI_VERSION=260000 \
    -o ../build/glue.js \
    ${LUA_SRC}

# The glue for `filesystem: 'host'`, which Emscripten only supports under Node. NODERAWFS forwards
# every file operation straight to node:fs, so paths, the working directory, symlinks and
# permissions are the host's rather than a mirror of them. NODE_HOST_ENV stays off so the
# environment is still whatever LuaModuleOptions `env` says, as it is in the default glue.
emcc "${COMMON[@]}" \
    -s NODERAWFS=1 \
    -s NODE_HOST_ENV=0 \
    -s ENVIRONMENT="node" \
    -o ../build/host/glue.js \
    ${LUA_SRC}

# Both glues are the same wasm with a different filesystem bolted on in JS, which is what lets the
# package ship one binary and pick a glue at load time. Checked rather than assumed, because a
# divergence would otherwise surface as a corrupt module for host users only.
if ! cmp -s ../build/glue.wasm ../build/host/glue.wasm; then
    echo "build-wasm: the host glue produced a different glue.wasm, so the two cannot share one binary" >&2
    exit 1
fi
# Dropped so only one copy is published; the host glue resolves 'glue.wasm' next to itself, and the
# bundle puts both of them in dist/ beside the shared binary.
rm ../build/host/glue.wasm
