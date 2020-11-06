# Wasmoon

This package aims to provide a way to:

* Embed Lua to any Node.js, Deno and modern browsers.
* Run lua code in any operational system

## CLI Usage
Wasmoon by default reads and execute code from stdin, but you can force it to read from file passing the `-f` argument:

```sh
$: wasmoon -f file.lua
```

Or using npx:
```
$: npx wasmoon -f file.lua
```

## Api documentation
To initialize wasmoon on your project:

```js
const { Lua } = require('wasmoon')
await Lua.ensureInitialization()
```

Create a new Lua state, register the standard library, set a global variable, execute a code and get a global variable:

```js
const state = new Lua();

try {
    state.registerStandardLib();
    state.setGlobal('sum', (x, y) => x + y);
    state.doString(`
    print(sum(10, 10))
    function multiply(x, y)
        return x * y
    end
    `);
    const multiply = state.getGlobal('multiply');
    console.log(multiply(10, 10))
} finally {
    state.close();
}
```

