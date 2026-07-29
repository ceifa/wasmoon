import { LuaRuntime } from '../dist/index.js'

export const getLua = (options) => {
    return LuaRuntime.load(options)
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

/** Windows paths cannot go into a Lua string literal as they are. */
export const luaPath = (path) => path.replace(/\\/g, '/')
