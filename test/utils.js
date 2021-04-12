const { LuaFactory } = require('../dist')

process.setMaxListeners(0)

module.exports = {
    getFactory: (env) => {
        return new LuaFactory(undefined, env)
    },
    getEngine: () => {
        return new LuaFactory().createEngine({
            injectObjects: true,
        })
    },
    // Used to make the event loop cycle
    tick: () => {
        return new Promise((resolve) => setImmediate(resolve))
    },
}
