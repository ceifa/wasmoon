const { LuaFactory } = require('../dist')

process.setMaxListeners(0)

module.exports = {
    getEngine: () => {
        return new LuaFactory().createEngine()
    },
}
