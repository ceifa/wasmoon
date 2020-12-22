# Wasmoon

This package aims to provide a way to:

* Embed Lua to any Node.js, Deno or Web Application.
* Run lua code in any operational system

## Installation

#### Globally via `npm`

```sh
$: npm install -g wasmoon
```
This will install `wasmoon` globally so that it may be run from the command line anywhere.

#### Running on-demand:

Using `npx` you can run the script without installing it first:

```sh
$: npx wasmoon
```

## CLI Usage
Wasmoon by default reads and execute code from stdin, but you can force it to read from file passing the `-f` argument:

```sh
$: wasmoon -f file.lua
```

## API Usage

To initialize, create a new Lua state, register the standard library, set a global variable, execute a code and get a global variable:

```js
const { LuaFactory } = require('wasmoon')

const lua = await new LuaFactory().createEngine();

try {
    lua.global.set('sum', (x, y) => x + y);
    lua.doString(`
    print(sum(10, 10))
    function multiply(x, y)
        return x * y
    end
    `);
    const multiply = lua.global.get('multiply');
    console.log(multiply(10, 10))
} finally {
    lua.global.close();
}
```