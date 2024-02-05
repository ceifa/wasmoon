import { CreateEngineOptions, EnvironmentVariables } from './types'
import LuaEngine from './engine'
import LuaWasm from './luawasm'
// A rollup plugin will resolve this to the current version on package.json
import version from 'package-version'

/**
 * Represents a factory for creating and configuring Lua engines.
 */
export default class LuaFactory {
    /**
     * Promise for the Lua WebAssembly module.
     * @private
     */
    private luaWasmPromise: Promise<LuaWasm>

    /**
     * Constructs a new LuaFactory instance.
     * @param [customWasmUri] - Custom URI for the Lua WebAssembly module.
     * @param [environmentVariables] - Environment variables for the Lua engine.
     */
    public constructor(customWasmUri?: string, environmentVariables?: EnvironmentVariables) {
        if (customWasmUri === undefined) {
            const isBrowser =
                (typeof window === 'object' && typeof window.document !== 'undefined') ||
                (typeof self === 'object' && self?.constructor?.name === 'DedicatedWorkerGlobalScope')

            if (isBrowser) {
                customWasmUri = `https://unpkg.com/wasmoon@${version}/dist/glue.wasm`
            }
        }

        this.luaWasmPromise = LuaWasm.initialize(customWasmUri, environmentVariables)
    }

    /**
     * Mounts a file in the Lua environment asynchronously.
     * @param path - Path to the file in the Lua environment.
     * @param content - Content of the file to be mounted.
     * @returns - A Promise that resolves once the file is mounted.
     */
    public async mountFile(path: string, content: string | ArrayBufferView): Promise<void> {
        this.mountFileSync(await this.getLuaModule(), path, content)
    }

    /**
     * Mounts a file in the Lua environment synchronously.
     * @param luaWasm - Lua WebAssembly module.
     * @param path - Path to the file in the Lua environment.
     * @param content - Content of the file to be mounted.
     */
    public mountFileSync(luaWasm: LuaWasm, path: string, content: string | ArrayBufferView): void {
        const fileSep = path.lastIndexOf('/')
        const file = path.substring(fileSep + 1)
        const body = path.substring(0, path.length - file.length - 1)

        if (body.length > 0) {
            const parts = body.split('/').reverse()
            let parent = ''

            while (parts.length) {
                const part = parts.pop()
                if (!part) {
                    continue
                }

                const current = `${parent}/${part}`
                try {
                    luaWasm.module.FS.mkdir(current)
                } catch (err) {
                    // ignore EEXIST
                }

                parent = current
            }
        }

        luaWasm.module.FS.writeFile(path, content)
    }

    /**
     * Creates a Lua engine with the specified options.
     * @param [options] - Configuration options for the Lua engine.
     * @returns - A Promise that resolves to a new LuaEngine instance.
     */
    public async createEngine(options: CreateEngineOptions = {}): Promise<LuaEngine> {
        return new LuaEngine(await this.getLuaModule(), options)
    }

    /**
     * Gets the Lua WebAssembly module.
     * @returns - A Promise that resolves to the Lua WebAssembly module.
     */
    public async getLuaModule(): Promise<LuaWasm> {
        return this.luaWasmPromise
    }
}
