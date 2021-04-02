const { LuaFactory } = require('../dist')

module.exports = {
    getEngine: () => {
        return new LuaFactory().createEngine()
    },
}
