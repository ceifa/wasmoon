const { Lua } = require('../dist');

// TODO: Create some real unit tests

(async () => {
    await Lua.ensureInitialization();

    const state = new Lua();
    state.registerStandardLib();
    state.setGlobal('sum', (x, y) => {
        return x + y;
    });
    state.doString(`
        print(sum(10, 50))
    `);
    state.close();
})();
