const { LuaFactory } = require('../dist')

module.exports = {
    getEngine: async () => {
        return await new LuaFactory().createEngine()
    }
}