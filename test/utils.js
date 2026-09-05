import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/**
 * Hands out temporary directories and removes every one of them afterwards, so a test that needs a
 * second or third one does not have to carry its own try/finally.
 */
export const useTempDirs = (prefix) => {
    const created = []
    const createTempDir = () => {
        const dir = mkdtempSync(join(tmpdir(), `wasmoon-${prefix}-`))
        created.push(dir)
        return dir
    }

    afterEach(() => {
        for (const dir of created.splice(0)) {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    return createTempDir
}

/**
 * Reads a file from inside Lua. The sentinel distinguishes "empty" from "not reachable at all",
 * which a bare read cannot.
 */
export const readFileFromLua = (state, path) => {
    return state.doStringSync(`
        local f = io.open("${luaPath(path)}", "r")
        if not f then return "BLOCKED" end
        local content = f:read("*a")
        f:close()
        return content
    `)
}
