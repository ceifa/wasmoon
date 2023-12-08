[![Build Status](https://github.com/ceifa/wasmoon/actions/workflows/publish.yml/badge.svg)](https://github.com/ceifa/wasmoon/actions/workflows/publish.yml)
[![npm](https://img.shields.io/npm/v/wasmoon.svg)](https://npmjs.com/package/wasmoon)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# Wasmoon

This package aims to provide a way to:

-   Embed Lua to any Node.js, Deno or Web Application.
-   Run lua code in any operational system
-   Interop Lua and JS without memory leaks (including the DOM)

## API Usage

To initialize, create a new Lua state, register the standard library, set a global variable, execute a code and get a global variable:

```js
const { LuaFactory } = require('wasmoon')

// Initialize a new lua environment factory
// You can pass the wasm location as the first argument, useful if you are using wasmoon on a web environment and want to host the file by yourself
const factory = new LuaFactory()
// Create a standalone lua environment from the factory
const lua = await factory.createEngine()

try {
    // Set a JS function to be a global lua function
    lua.global.set('sum', (x, y) => x + y)
    // Run a lua string
    await lua.doString(`
    print(sum(10, 10))
    function multiply(x, y)
        return x * y
    end
    `)
    // Get a global lua function as a JS function
    const multiply = lua.global.get('multiply')
    console.log(multiply(10, 10))
} finally {
    // Close the lua environment, so it can be freed
    lua.global.close()
}
```

## CLI Usage

Although Wasmoon has been designed to be embedded, you can run it on command line as well, but, if you want something more robust on this, we recommend to take a look at [demoon](https://github.com/ceifa/demoon).

```sh
$: wasmoon [options] [file] [args]
```

Available options are:

-   `-l`: Include a file or directory
-   `-i`: Enter interactive mode after running the files

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

Wasmoon compiles the [official Lua code](https://github.com/lua/lua) to webassembly and creates an abstraction layer to interop between Lua and JS, instead of [fengari](https://github.com/fengari-lua/fengari), that is an entire Lua VM rewritten in JS.

### Performance

Because of wasm, wasmoon will run Lua code much faster than fengari, but if you are going to interop a lot between JS and Lua, this may be not be true anymore, you probably should test on you specific use case to take the prove.

This is the results running a [heap sort code](https://github.com/ceifa/wasmoon/blob/main/bench/heapsort.lua) in a list of 2k numbers 10x(less is better):

| wasmoon  | fengari   |
| -------- | --------- |
| 15.267ms | 389.923ms |

### Size

Fengari is smaller than wasmoon, which can improve the user experience if in web environments:

|             | wasmoon | fengari |
| ----------- | ------- | ------- |
| **plain**   | 393kB   | 214kB   |
| **gzipped** | 130kB   | 69kB    |

## Fixing common errors on web environment

Bundle/require errors can happen because wasmoon tries to safely import some node modules even in a browser environment, the bundler is not prepared to that since it tries to statically resolve everything on build time.
Polyfilling these modules is not the right solution because they are not actually being used, you just have to ignore them:

### Webpack

Add the `resolve.fallback` snippet to your config:

```js
module.exports = {
    entry: './src/index.js', // Here is your entry file
    resolve: {
        fallback: {
            path: false,
            fs: false,
            child_process: false,
            crypto: false,
            url: false,
            module: false,
        },
    },
}
```

### Rollup

With the package [rollup-plugin-ignore](https://www.npmjs.com/package/rollup-plugin-ignore), add this snippet to your config:

```js
export default {
    input: 'src/index.js', // Here is your entry file,
    plugins: [ignore(['path', 'fs', 'child_process', 'crypto', 'url', 'module'])],
}
```

### Angular

Add the section browser on `package.json`:

```json
{
    "main": "src/index.js",
    "browser": {
        "child_process": false,
        "fs": false,
        "path": false,
        "crypto": false,
        "url": false,
        "module": false
    }
}
```

## How to build

Firstly download the lua submodule and install the other Node.JS dependencies:

```sh
git submodule update --init # download lua submodule
npm i # install dependencies
```

### Windows / Linux / MacOS (Docker way)

You need to install [docker](https://www.docker.com/) and ensure it is on your `PATH`.

After cloned the repo, to build you just have to run these:

```sh
npm run build:wasm:docker:dev # build lua
npm run build # build the js code/bridge
npm test # ensure everything it's working fine
```

### Ubuntu / Debian / MacOS

You need to install [emscripten](https://emscripten.org/) and ensure it is on your `PATH`.

After cloned the repo, to build you just have to run these:

```sh
npm run build:wasm:dev # build lua
npm run build # build the js code/bridge
npm test # ensure everything it's working fine
```

## Edge Cases

### Null

`null` is injected as userdata type if `injectObjects` is set to `true`. This works as expected except that it will evaluate to `true` in Lua.

### Promises

Promises can be await'd from Lua with some caveats detailed in the below section. To await a Promise call `:await()` on it which will yield the Lua execution until the promise completes.

```js
const { LuaFactory } = require('wasmoon')
const factory = new LuaFactory()
const lua = await factory.createEngine()

try {
    lua.global.set('sleep', (length) => new Promise((resolve) => setTimeout(resolve, length)))
    await lua.doString(`
        sleep(1000):await()
    `)
} finally {
    lua.global.close()
}
```

### Async/Await

It's not possible to await in a callback from JS into Lua. This is a limitation of Lua but there are some workarounds. It can also be encountered when yielding at the top-level of a file. An example where you might encounter this is a snippet like this:

```js
local res = sleep(1):next(function ()
    sleep(10):await()
    return 15
end)
print("res", res:await())
```

Which will throw an error like this:

```
Error: Lua Error(ErrorRun/2): cannot resume dead coroutine
    at Thread.assertOk (/home/tstableford/projects/wasmoon/dist/index.js:409:23)
    at Thread.<anonymous> (/home/tstableford/projects/wasmoon/dist/index.js:142:22)
    at Generator.throw (<anonymous>)
    at rejected (/home/tstableford/projects/wasmoon/dist/index.js:26:69)
```

Or like this:

```
attempt to yield across a C-call boundary
```

You can workaround this by doing something like below:

```lua
function async(callback)
    return function(...)
        local co = coroutine.create(callback)
        local safe, result = coroutine.resume(co, ...)

        return Promise.create(function(resolve, reject)
            local function step()
                if coroutine.status(co) == "dead" then
                    local send = safe and resolve or reject
                    return send(result)
                end

                safe, result = coroutine.resume(co)

                if safe and result == Promise.resolve(result) then
                    result:finally(step)
                else
                    step()
                end
            end

            result:finally(step)
        end)
    end
end
```
