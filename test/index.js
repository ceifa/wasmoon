const { LuaState } = require('../dist');

// TODO: Create some real unit tests

(async () => {
    await LuaState.ensureInitialization();

    const state = new LuaState();
    state.registerStandardLib();
    state.doString("answerToEverything = 42");
    console.log(state.getGlobal('answerToEverything'))
    state.close();
})();
