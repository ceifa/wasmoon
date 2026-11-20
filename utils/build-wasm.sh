#!/bin/bash -e
cd $(dirname $0)
mkdir -p ../build/host ../build/none

LUA_SRC="$(ls ../lua/*.c | grep -v "luac.c" | grep -v "lua.c" | tr "\n" " ") ../src/native/wasmoon.c"

if [ "$1" == "dev" ];
then
    # With assertions the filesystem glues export strerror for their error messages, and every glue
    # has to export it for them all to share one wasm.
    extension=(-O0 -g3 -s ASSERTIONS=1 -s SAFE_HEAP=1 -s STACK_OVERFLOW_CHECK=2 -Wl,--export=strerror)
else
    extension=(-Oz -DLUA_USE_JUMPTABLE=0 -s BINARYEN_EXTRA_PASSES=gufa-optimizing,converge)
fi

# What the JS side reaches into on every glue. The filesystem glues add FS, NODEFS and PATH to it.
RUNTIME_METHODS="'addFunction', 'removeFunction', 'ENV', 'getValue', 'setValue', 'lengthBytesUTF8', \
    'stringToUTF8', 'stringToNewUTF8', 'stringToUTF8OnStack', 'stackSave', 'stackRestore', \
    'UTF8ToString', 'HEAPU8', 'HEAPU32'"
# The wasm is never fetched by the glue: LuaModule compiles it and hands it over through instantiateWasm.
INCOMING_API="'instantiateWasm', 'preRun', 'print', 'printErr'"

# Everything that is not about the filesystem, shared by all three glues below so they can share
# one `glue.wasm`.
COMMON=(
    -s WASM=1
    -s SUPPORT_LONGJMP=wasm
    -I../lua
    "${extension[@]}"
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
    # minimums are in BROWSERS below.
    -s MIN_NODE_VERSION=260000
    # The Lua C API and the functions of src/native/wasmoon.c, as listed by create-bindings.js from
    # the headers. build-wasm.js runs it ahead of this script.
    -s EXPORTED_FUNCTIONS=@../build/exported-functions.json
)

FILESYSTEM=(
    -s EXPORTED_RUNTIME_METHODS="[$RUNTIME_METHODS, 'FS', 'NODEFS', 'PATH']"
    -s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE="['\$FS_mkdirTree', '\$PATH', '\$PATH_FS']"
    -s INCOMING_MODULE_JS_API="[$INCOMING_API]"
)
# The engines package.json promises for the browser. Only on the glues that run there: the host
# glue is Node only and would warn about them.
BROWSERS=(
    -s MIN_CHROME_VERSION=134
    -s MIN_FIREFOX_VERSION=138
    -s MIN_SAFARI_VERSION=260000
)

# The default glue, for every environment. Its filesystem is Emscripten's in-memory one, and
# -lnodefs.js adds the NODEFS backend so a host directory can be mounted into it (LuaModuleOptions
# `mounts`). Nothing here reaches the host on its own.
emcc "${COMMON[@]}" \
    "${FILESYSTEM[@]}" \
    "${BROWSERS[@]}" \
    -lnodefs.js \
    -s ENVIRONMENT="web,worker,node" \
    -o ../build/glue.js \
    ${LUA_SRC}

# The glue for `filesystem: 'host'`, which Emscripten only supports under Node. NODERAWFS forwards
# every file operation straight to node:fs, so paths, the working directory, symlinks and
# permissions are the host's rather than a mirror of them. NODE_HOST_ENV stays off so the
# environment is still whatever LuaModuleOptions `env` says, as it is in the default glue.
emcc "${COMMON[@]}" \
    "${FILESYSTEM[@]}" \
    -s NODERAWFS=1 \
    -s NODE_HOST_ENV=0 \
    -s ENVIRONMENT="node" \
    -o ../build/host/glue.js \
    ${LUA_SRC}

# The glue for `fs: 'none'`, with no filesystem at all: a third of the size of the default one,
# since Emscripten's FS is most of that. The file syscalls fail and stdio goes straight to the
# LuaModuleOptions callbacks, both through no-filesystem.js.
emcc "${COMMON[@]}" \
    "${BROWSERS[@]}" \
    -s FILESYSTEM=0 \
    -s EXPORTED_RUNTIME_METHODS="[$RUNTIME_METHODS]" \
    -s INCOMING_MODULE_JS_API="[$INCOMING_API, 'stdin', 'stdout', 'stderr']" \
    --js-library no-filesystem.js \
    -s ENVIRONMENT="web,worker,node" \
    -o ../build/none/glue.js \
    ${LUA_SRC}

# The glues are the same wasm with a different filesystem bolted on in JS, which is what lets the
# package ship one binary and pick a glue at load time. Checked rather than assumed, because a
# divergence would otherwise surface as a corrupt module for the users of one glue only.
for glue in host none; do
    if ! cmp -s ../build/glue.wasm ../build/$glue/glue.wasm; then
        echo "build-wasm: the $glue glue produced a different glue.wasm, so the glues cannot share one binary" >&2
        exit 1
    fi
    # Dropped so only one copy is published; each glue resolves 'glue.wasm' next to itself, and the
    # bundle puts all of them in dist/ beside the shared binary.
    rm ../build/$glue/glue.wasm
done
