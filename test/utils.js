const { Lua } = require('../dist')

module.exports = {
    getEngine: async () => {
        await Lua.ensureInitialization()
        return new Lua()
    }
}