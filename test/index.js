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
        print(sum(10, 50) == 60)
        function sum2(x, y)
            return x + y
        end
    `);
    const sum2 = state.getGlobal('sum2');
    console.log(sum2(10, 50) === 60)
    state.close();
})();
