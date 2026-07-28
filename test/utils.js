import { LuaRuntime } from '../dist/index.js'

export const getLua = (env) => {
    return LuaRuntime.load({ env })
}

export const getState = async (config = {}) => {
    const lua = await LuaRuntime.load()
    return lua.createState({
        inject: true,
        ...config,
    })
}

// Used to make the event loop cycle
export const tick = () => {
    return new Promise((resolve) => setImmediate(resolve))
}
