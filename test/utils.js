const { LuaFactory } = require('..')

module.exports.getFactory = (env) => {
    return new LuaFactory(undefined, env)
}

module.exports.getEngine = (config = {}) => {
    return new LuaFactory().createEngine({
        injectObjects: true,
        ...config,
    })
}

// Used to make the event loop cycle
module.exports.tick = () => {
    return new Promise((resolve) => setImmediate(resolve))
}
