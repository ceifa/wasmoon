import { LuaFactory } from '../dist/index.js'

export const getFactory = (env) => {
    return new LuaFactory({ env })
}

export const getEngine = (config = {}) => {
    return new LuaFactory().createEngine({
        injectObjects: true,
        ...config,
    })
}

// Used to make the event loop cycle
export const tick = () => {
    return new Promise((resolve) => setImmediate(resolve))
}
