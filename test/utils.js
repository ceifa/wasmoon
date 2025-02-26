import { Lua } from '../dist/index.js'

export const getLua = (env) => {
    return Lua.load({ env })
}

export const getState = async (config = {}) => {
    const lua = await Lua.load()
    return lua.createState({
        injectObjects: true,
        ...config,
    })
}

// Used to make the event loop cycle
export const tick = () => {
    return new Promise((resolve) => setImmediate(resolve))
}
