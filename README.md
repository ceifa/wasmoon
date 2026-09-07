[![Build Status](https://github.com/ceifa/wasmoon/actions/workflows/publish.yml/badge.svg)](https://github.com/ceifa/wasmoon/actions/workflows/publish.yml)
[![npm](https://img.shields.io/npm/v/wasmoon.svg)](https://npmjs.com/package/wasmoon)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# Wasmoon

This package aims to provide a way to:

- Embed Lua to any Node.js, Deno or Web Application.
- Run lua code in any operational system
- Interop Lua and JS without memory leaks (including the DOM)

## API Usage

Load the wasm module once, create a state on it, then set a global, run some Lua and read a global back:

```js
import { LuaRuntime } from 'wasmoon'

// Loads the Lua wasm module. Every state created from it shares the filesystem and stdio.
const lua = await LuaRuntime.load()
// A standalone Lua state, with the standard library open
const state = lua.createState()

try {
    // Set a JS function to be a global lua function
    state.set('sum', (x, y) => x + y)
    // Run a lua string
    await state.doString(`
    print(sum(10, 10))
    function multiply(x, y)
        return x * y
    end
    `)
    // Get a global lua function as a JS function
    const multiply = state.get('multiply')
    console.log(multiply(10, 10))
} finally {
    // Close the state, so it can be freed
    state.close()
}
```

Loading the module is the expensive part, so keep one `LuaRuntime` around and create a state per
sandbox. `lua.close()` closes every state created from it, and both types support `using`:

```js
await using lua = await LuaRuntime.load()
```

## Filesystem

Every state on a runtime shares one filesystem. By default it is in memory: the same in Node, the
browser and a worker, and it holds nothing but what you put in it.

```js
const lua = await LuaRuntime.load()
lua.writeFile('/scripts/greet.lua', 'return "hello"')

const state = lua.createState()
await state.doString('return require("scripts.greet")')
```

`writeFile`, `readFile`, `readTextFile`, `exists`, `cwd` and `chdir` cover the everyday cases;
`lua.filesystem` is Emscripten's own API for everything else.

### Reaching the host

Two ways, and neither is the default:

```js
// One host directory, at a path you choose. Node only. Nothing else on the host is reachable.
const lua = await LuaRuntime.load({ mounts: { '/scripts': './lua' } })
await lua.createState().doString('return dofile("/scripts/init.lua")')

// Or the real filesystem, with the process working directory, absolute paths and symlinks.
// Node only, and not a sandbox: Lua can read and write whatever the process can.
const cli = await LuaRuntime.load({ fs: 'host' })
```

`mounts` maps the path Lua sees to a host directory that has to exist; mount points cannot nest, and
`lua.mount(virtualPath, hostPath)` / `lua.unmount(virtualPath)` do the same after loading. With
`fs: 'host'` there is nothing to mount, because every host path already resolves — and `lua.chdir`
moves the Node process itself, since a process has only one working directory.

> [!WARNING]
> A filesystem is not a sandbox on its own. Lua's `os.execute` runs a real command through the shell
> in Node whichever filesystem you pick, and `os.exit` sets the host process exit code. Leave `os`
> out of the state (`createState({ libs: [...] })`) if untrusted code must not do either.

## CLI Usage

Although Wasmoon has been designed to be embedded, you can run it on command line as well, but, if you want something more robust on this, we recommend to take a look at [demoon](https://github.com/ceifa/demoon).

```sh
$: wasmoon [options] [file] [args]
```

Available options are:

- `-l`: Include a file or directory
- `-i`: Enter interactive mode after running the files

### Example:

```sh
$: wasmoon -i sum.lua 10 30
```

And if you are in Unix, you can also use it as a script interpreter with [Shebang](<https://en.wikipedia.org/wiki/Shebang_(Unix)>):

```lua
#!/usr/bin/env wasmoon
return arg[1] + arg[2]
```

```sh
$: ./sum.lua 10 30
```

## When to use wasmoon and fengari

Wasmoon compiles the [official Lua code](https://github.com/lua/lua) to WebAssembly and creates an abstraction layer to interop between Lua and JS, instead of [fengari](https://github.com/fengari-lua/fengari), which is an entire Lua VM rewritten in JS.

### Performance

Because of WebAssembly, wasmoon runs Lua code significantly faster than fengari. The table below shows results from a [heap sort benchmark](https://github.com/ceifa/wasmoon/blob/main/bench/heapsort.lua) sorting a list of 2,000 numbers (100 iterations, 5 warmup):

|             | avg       | median    | min       | max       | stddev   | relative |
| ----------- | --------- | --------- | --------- | --------- | -------- | -------- |
| **Wasmoon** | 13.41 ms  | 13.07 ms  | 12.20 ms  | 16.23 ms  | 1.12 ms  | 1.00x    |
| **Fengari** | 137.36 ms | 138.51 ms | 119.70 ms | 165.54 ms | 11.16 ms | 10.24x   |

Wasmoon is **~10x faster** than fengari for pure Lua execution. If your use case involves heavy interop between JS and Lua, the difference may be smaller, benchmark your specific scenario.

### Size

Fengari is smaller than wasmoon, which can improve the user experience if in web environments.
Both minified, and wasmoon counted as its JS plus `glue.wasm`:

|             | wasmoon          | fengari |
| ----------- | ---------------- | ------- |
| **plain**   | 294kB (97 + 197) | 228kB   |
| **gzipped** | 124kB (29 + 95)  | 74kB    |

Almost all of wasmoon's weight is the wasm, which is a separate file: it is fetched in parallel
with your JS rather than parsed as part of it, and it caches on its own across releases of your app.

## Web environment

Bundlers need no configuration. wasmoon ships as ESM and marks the two node builtins it touches so
that a bundler targeting the browser skips them instead of failing to resolve them, and every
supported bundler produces a working browser build out of the box.

### Where `glue.wasm` comes from

The wasm is resolved next to the bundle, with `new URL('glue.wasm', import.meta.url)`. What that
means depends on your bundler:

| bundler | what happens                                                       |
| ------- | ------------------------------------------------------------------ |
| Vite    | inlines the wasm into the bundle, nothing else to do               |
| webpack | emits the wasm as an asset next to your output, nothing else to do |
| esbuild | does not handle the asset, see below                               |
| Rollup  | does not handle the asset, see below                               |

esbuild and Rollup leave nothing beside the bundle to fetch, so wasmoon falls back to unpkg with a
warning. That works, but it is a request to a third party pinned to wasmoon's version, so prefer
copying the wasm next to your output as part of the build, after which nothing else is needed:

```js
import { copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

await copyFile(fileURLToPath(import.meta.resolve('wasmoon/glue.wasm')), 'dist/glue.wasm')
```

Or host it wherever you like and say where it is:

```js
const lua = await LuaRuntime.load({ wasmFile: '/assets/glue.wasm' })
```

With Vite and webpack you want neither, since they already handle the asset. Asking for it again
(`wasmoon/glue.wasm?url` and friends) makes them ship the wasm twice.

### A page opened from `file://`

A page loaded over `file://` cannot fetch anything next to it, so the wasm has to come from
somewhere else and wasmoon falls back to unpkg. To keep such a page self contained, inline the wasm
and hand it over as a data URL:

```js
const lua = await LuaRuntime.load({ wasmFile: 'data:application/wasm;base64,...' })
```

Note that Chromium also refuses to load ES modules over `file://`, so the page has to carry your
bundle inline rather than in a `<script src>`.

## How to build

Firstly download the lua submodule and install the other Node.JS dependencies:

```sh
git submodule update --init # download lua submodule
npm i # install dependencies
```

Then build the wasm, the JS bridge, and check the result:

```sh
npm run build:wasm:dev # build lua
npm run build # build the js code/bridge
npx playwright install chromium # the browser tests drive a real browser
npm test # ensure everything it's working fine
```

Building the wasm needs either [emscripten](https://emscripten.org/) or
[docker](https://www.docker.com/) on your `PATH`. `emcc` is used when it is available, and docker
otherwise (always on Windows), so there is nothing to pick between. Drop the `:dev` for an optimized
build.

## Edge Cases

### Null

`null` is injected as userdata type if `inject` is set to `true`. This works as expected except that it will evaluate to `true` in Lua.

### Promises

Promises can be `await`'d from Lua by calling `:await()` on them, which parks the Lua execution until the promise settles and then returns its value (or raises its rejection as a Lua error).

```js
import { LuaRuntime } from 'wasmoon'

const lua = await LuaRuntime.load()
const state = lua.createState()

try {
    state.set('sleep', (length) => new Promise((resolve) => setTimeout(resolve, length)))
    await state.doString(`
        sleep(1000):await()
    `)
} finally {
    state.close()
}
```

### Async engine

There are two engines:

- **Coroutine yielding** is the fallback when JSPI is unavailable. An `:await()` parks by yielding
  the running coroutine, so it works at the top level of a run and anywhere Lua can yield.
- **JSPI** is selected automatically where available. It suspends the WebAssembly stack, allowing awaits across C-call
  boundaries such as `table.sort` comparators and `string.gsub` callbacks, and inside
  Lua-resumed coroutines. It requires a platform with JSPI support.

```js
const lua = await LuaRuntime.load() // JSPI when available, yielding otherwise
const accelerated = await LuaRuntime.load({ async: 'jspi' }) // requires JSPI
const portable = await LuaRuntime.load({ async: 'yield' }) // coroutine yielding on every platform
```

Both engines use the same run isolation, cancellation, and host-yield contract. Each run owns
its limits and interrupt state, even when several runs or states share a runtime. Repeated awaits
and host yields give the event loop a turn every 256 async steps, so timers can run without paying
for a macrotask on every await.

A run parked on a promise can be interrupted by a `timeout` or an `AbortSignal`, without waiting for
the promise to settle. This also applies while an `onYield` handler is pending; closing the state
rejects its parked runs and callbacks:

```js
await state.doString('sleep(60000):await()', { timeout: 1000 }) // rejects after ~1s
```

#### Awaiting in a JS→Lua callback

A Lua function called from JS runs synchronously and returns its value directly. If it `:await()`s,
the call becomes asynchronous and returns a `Promise` instead. These callbacks use coroutine
yielding even when JSPI is enabled, so they cannot await across C-call boundaries:

```js
state.set('handler', null)
await state.doString('handler = function(x) return sleep(10):await() + x end')
const handler = state.get('handler')
console.log(await handler(5)) // a promise, because the callback awaited
```

#### Handling a top-level `coroutine.yield`

A top level `coroutine.yield` that is not an `:await()` is a _host yield_. Pass `onYield` to receive
its values and decide what the resume hands back; its return may be a promise, a `LuaMultiReturn` of
several values, or a single value:

```js
const thread = state.newThread()
thread.loadString('local reply = coroutine.yield("ping") return reply')
const [result] = await thread.run(0, {
    onYield: (values) => {
        console.log(values[0]) // "ping"
        return 'pong'
    },
})
console.log(result) // "pong"
```

A promise passed to `coroutine.yield` is a host value, not an internal await. The handler receives
it unchanged. Without a handler, yielded values are discarded and the coroutine resumes without
arguments.
