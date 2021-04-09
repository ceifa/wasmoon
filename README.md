# Wasmoon

This package aims to provide a way to:

-   Embed Lua to any Node.js, Deno or Web Application.
-   Run lua code in any operational system

## Installation

#### Globally via `npm`

```sh
$: npm install -g wasmoon
```

This will install `wasmoon` globally so that it may be run from the command line anywhere.

#### Running on-demand:

Using `npx` you can run the CLI without installing it first, its very simple to open the interactive wasmoon:

```sh
$: npx wasmoon
```

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
$: wasmoon [options] [files] [-- [args]]
```

Available options are:

* `-l`: Include a file or directory
* `-i`: Enter interactive mode after running the *files*

### Example:

```
$: wasmoon -i sum.lua -- 10 30
```


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
        },
    },
}
```

### Rollup

With the package [rollup-plugin-ignore](), add this snippet to your config:

```js
export default {
    input: 'src/index.js', // Here is your entry file,
    plugins: [ignore(['path', 'fs', 'child_process', 'crypto', 'url'])],
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
        "url": false
    }
}
```
