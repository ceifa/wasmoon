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

## Passing values

A value crosses into Lua by what it is, unless you say otherwise:

| JS value                          | in Lua                                                                    |
| --------------------------------- | ------------------------------------------------------------------------- |
| number, bigint, string, boolean   | the same value                                                            |
| `undefined`, `null`               | `nil` (see [Null](#null))                                                 |
| function                          | a function                                                                |
| promise                           | a userdata with `:await()`, `:next()`, `:catch()` and `:finally()`        |
| `Error`                           | a read-only userdata that renders as its message                          |
| any other object, arrays included | a proxy: a userdata that forwards to the object, which keeps its identity |

A proxy exposes the object's members, so `obj.field`, `obj:method()`, `#arr`, `pairs(obj)` and
`arr[1]` (an array is indexed from 1, anything else by the key given) all reach the JS object.
Create the state with `objects: 'copy'` and an object is copied into a plain Lua table instead.

An error exposes its `message`, `name`, `stack` and whatever it carries as own properties (`code`,
`cause`, ...), and nothing inherited.

Coming back, a Lua table is copied into an object or an array, a Lua function becomes a JS
function, and a userdata that came from JS is the JS value it was.

### One value: `copy`, `proxy`, `opaque`, `raw`

```js
import { copy, proxy, opaque, raw } from 'wasmoon'

// Plain Lua data, all the way down, whatever the state's `objects` says
state.set('config', copy({ retries: 3, hosts: ['a', 'b'] }))
// By reference. On a function it makes the function indexable, and `.new(...)` constructs
state.set('Date', proxy(Date)) // Date.now(), Date.new(0):toISOString()
// By reference with nothing reachable: Lua can hold it and hand it back
state.set('session', opaque(session))
// A function that works on the Lua stack itself and returns how many values it pushed
state.set(
    'swap',
    raw((thread) => {
        thread.module.lua_rotate(thread.address, 1, 1)
        return 2
    }),
)
```

They work anywhere a value crosses, a return value or a field of a copied object included. With
`objects: 'copy'` they, and the two below, are the only ways Lua gets to reach into a JS object.

A function is always a function: nothing guesses whether it is a class. Wrap one in `proxy` to
reach its static members and construct it with `.new`, or define it.

### A class: `defineClass`

```js
class Vector {
    static zero = () => new Vector(0, 0)

    constructor(x, y) {
        this.x = x
        this.y = y
    }

    get length() {
        return Math.hypot(this.x, this.y)
    }

    add(other) {
        return new Vector(this.x + other.x, this.y + other.y)
    }
}

state.defineClass(Vector, {
    // Optional: the only members Lua can reach. Without it, all of them.
    members: ['x', 'y', 'length', 'add'],
    // Optional: metamethods, called with the instance first
    metamethods: { __tostring: (v) => `(${v.x}, ${v.y})`, __add: (a, b) => a.add(b) },
})
state.set('Vector', Vector)

await state.doString(`
    local v = Vector(3, 4) + Vector.zero()  -- or Vector.new(3, 4)
    print(v, v.length, v:add(v).x)          -- (3, 4)  5  6
`)
```

Every instance, wherever it comes from, then crosses by reference as a userdata named after the
class, and reads back as itself. Methods follow Lua's convention and nothing else: the receiver is
the first argument, which `v:add(w)` passes and `v.add(w)` does not. An instance of a subclass uses
the nearest class that was defined.

### A kind of value: `defineType`

```js
// By reference, with a metatable of its own
state.defineType({
    name: 'Point',
    match: (value) => value instanceof Point,
    metatable: { __tostring: (point) => `Point(${point.x}, ${point.y})` },
})

// Or converted on the way in, and back on the way out
state.defineType({
    name: 'Map',
    match: (value) => value instanceof Map,
    toLua: (map) => copy(Object.fromEntries(map)),
    fromLua: (table) => new Map(Object.entries(table)),
})
```

`fromLua` is given what the table reads as, for a table `toLua` produced and for one Lua code gave
a metatable whose `__name` is the type's name.

The order is the whole rule: a wrapped value crosses the way its wrapper says; then the types take
what they match, the most recently defined first; then the classes take their instances, the most
derived first; and everything else goes by the table above.

## Limits

A run is each entry from JS into Lua: a `doString` or `doFile`, a call of a Lua function, and the
runs that `state.async`, Lua's `async` and a promise reaction start. What a run may use is said
with the same three fields everywhere:

```js
// What every run on the state starts under
const state = lua.createState({ limits: { timeout: 1000, maxInstructions: 10_000_000 } })

// One run, where each field given replaces the state's, and Infinity lifts it
await state.doString(script, { timeout: 50, signal: controller.signal })
await state.async(handler, { timeout: Infinity })(request)

// Later runs, leaving the ones under way alone
state.limits.timeout = 200
```

- `timeout`: milliseconds the run may take, awaits included. Raises `LuaTimeoutError`.
- `maxInstructions`: instructions it may execute. Raises `LuaInstructionLimitError`.
- `signal`: an `AbortSignal` that interrupts it. Raises `LuaAbortError`.

All three extend `LuaInterruptError`. A run made from inside another, by a JS function that Lua
called calling back into Lua, stays within the outer one's limits as well as its own: it cannot
outlast its deadline, it spends from its budget (counted in steps of a thousand instructions), and
its signal aborts it. A run that goes on after its caller returns, as every asynchronous one does,
is on its own.

`createState({ memory: { max } })` caps what a state may allocate, and `state.memory.max` changes it.

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

|             | wasmoon           | fengari |
| ----------- | ----------------- | ------- |
| **plain**   | 302kB (108 + 194) | 228kB   |
| **gzipped** | 128kB (34 + 94)   | 74kB    |

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

`null` is injected as userdata type if `inject` is `true` or names `'null'`. This works as expected except that it will evaluate to `true` in Lua.

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

### Where `:await()` works

An `:await()` suspends the WebAssembly stack itself, through
[JSPI](https://github.com/WebAssembly/js-promise-integration). That makes it work anywhere inside an
asynchronous run (`doString`, `doFile`, `thread.run`, a function made asynchronous as below): at the
top level, inside a `pcall`, across C-call boundaries such as a `table.sort` comparator or a
`string.gsub` callback, and inside a coroutine that Lua code resumes, whose resumer simply waits.

It needs a platform with JSPI: Chrome or Edge 137, Firefox 153, Safari 27, Node.js 25, or newer.
Everything else works without it, and an `:await()` raises an error saying so; `LuaRuntime.canAwait`
tells which one you are on.

A synchronous call cannot be suspended, so an `:await()` reached through `doStringSync`,
`doFileSync`, `call` or a Lua function called directly from JS is an error.

#### Functions that await

A Lua function handed to JS is called synchronously and returns its value directly. To let it
await, make it asynchronous, the way `async function` does in JS. From JS that is `state.async`,
which returns a function that starts the Lua one as a run of its own and gives back a promise of
its first result:

```js
state.set('sleep', (length) => new Promise((resolve) => setTimeout(resolve, length)))
const handler = await state.doString('return function(x) sleep(10):await() return x + 1 end')

handler(5) // throws: cannot await inside a synchronous call
await state.async(handler)(5) // 6
emitter.on('request', state.async(handler)) // or hand it to whatever takes a callback
state.async(handler, { timeout: 1000 }) // takes the same options as a run
```

From Lua it is `async`, one of the globals `inject` defines. Wrap a callback in it before handing
it to a JS API, and it can await whoever calls it:

```lua
-- setTimeout calls the function synchronously, which on its own could not await
setTimeout(async(function()
    sleep(10):await()
    print("later")
end), 100)

-- and it is how to start work without waiting for it
local fetchPage = async(function(url) return fetch(url):await() end)
local pages = Promise.all({ fetchPage(a), fetchPage(b) }):await()
```

The Lua functions given to a promise's `next`, `catch` and `finally` are asynchronous already:

```lua
local res = sleep(1):next(function()
    sleep(10):await()
    return 15
end)
print("res", res:await())
```

Each call of an asynchronous function is a run like a `doString`, under the same
[limits](#limits).

As with an async function in JS, an error in one rejects the promise it returned. When a JS API
called it and dropped that promise, the rejection is unhandled, which by default ends a Node
process. Pass `onAsyncError` when creating the state to receive those errors instead:

```js
const state = lua.createState({ inject: true, onAsyncError: (error) => console.error(error) })
```

`inject: true` defines `Promise`, `async`, `Error` and `null`. That last one is a sentinel a JS
`null` is marshalled as, and it is truthy in Lua; to leave it out, name the ones you want:
`inject: ['Promise', 'async']`.

#### Interrupting a parked run

A run parked on a promise is interrupted by its `timeout` or `AbortSignal` without waiting for the
promise to settle, and so is one waiting on an `onYield` handler. Closing the state rejects its
parked runs.

```js
await state.doString('sleep(60000):await()', { timeout: 1000 }) // rejects after ~1s
```

The interrupt is raised as an error at the `:await()`, so the scopes it unwinds close their
to-be-closed variables. A `pcall` around the await catches it like any other error, but the run
still rejects with it, and every `:await()` the script reaches afterwards is interrupted at once.

Each run owns its limits and interrupt state, even when several runs or states share a runtime. A
loop of awaits gives the event loop a turn every 256 of them, so timers can run without paying for a
macrotask on every await.

#### Handling a top-level `coroutine.yield`

A top level `coroutine.yield` is a _host yield_. Pass `onYield` to receive its values and decide
what the resume hands back; its return may be a promise, a `LuaMultiReturn` of several values, or a
single value:

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

A promise passed to `coroutine.yield` is a host value like any other, which the handler receives
unchanged. Without a handler the yielded values are discarded, the event loop gets a turn, and the
coroutine resumes without arguments.
