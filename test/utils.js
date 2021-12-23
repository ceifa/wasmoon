const { LuaFactory } = require('../dist')

process.setMaxListeners(0)

module.exports = {
    getFactory: (env) => {
        return new LuaFactory(undefined, env)
    },
    getEngine: (config = {}) => {
        return new LuaFactory().createEngine({
            injectObjects: true,
            ...config
        })
    },
    // Used to make the event loop cycle
    tick: () => {
        return new Promise((resolve) => setImmediate(resolve))
    },
}
