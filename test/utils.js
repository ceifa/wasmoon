import { LuaFactory } from '../dist'

export const getFactory = (env) => {
    return new LuaFactory(undefined, env)
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
