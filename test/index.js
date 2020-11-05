const { Lua } = require('../dist');

// TODO: Create some real unit tests

(async () => {
    await Lua.ensureInitialization();

    const state = new Lua();
    state.registerStandardLib();
    state.setGlobal('myglobal', 'samu')
    state.doString(`
        answerToEverything = { banana = 1, apple = [[testing]], obj = { test = 1337 } }
        answerToEverything.recursion = answerToEverything
        answerToEverything[answerToEverything] = 1
        print(myglobal)
    `);
    state.close();
})();
