import LuaModule from './module'
import LuaEngine from './engine'
import { CreateEngineOptions } from './types'

/**
 * Represents a factory for creating and configuring Lua engines.
 */
export default class Lua {
    /**
     * Constructs a new LuaFactory instance.
     * @param opts.wasmFile - Custom URI for the Lua WebAssembly module.
     * @param opts.env - Environment variables for the Lua engine.
     * @param opts.stdin - Standard input for the Lua engine.
     * @param opts.fs - File system that should be used for the Lua engine.
     * @param opts.stdout - Standard output for the Lua engine.
     * @param opts.stderr - Standard error for the Lua engine.
     */
    public static async load(luaModuleOpts: Parameters<typeof LuaModule.initialize>[0] = {}): Promise<Lua> {
        return new Lua(await LuaModule.initialize(luaModuleOpts))
    }

    public constructor(public readonly module: LuaModule) {}

    public createState(stateOpts: CreateEngineOptions = {}): LuaEngine {
        return new LuaEngine(this.module, stateOpts)
    }

    /**
     * Mounts a file in the Lua environment synchronously.
     * @param path - Path to the file in the Lua environment.
     * @param content - Content of the file to be mounted.
     */
    public mountFile(path: string, content: string | ArrayBufferView): void {
        const dirname = this.module._emscripten.PATH.dirname(path)
        this.module._emscripten.FS.mkdirTree(dirname)
        this.module._emscripten.FS.writeFile(path, content)
    }

    public get filesystem(): typeof this.module._emscripten.FS {
        return this.module._emscripten.FS
    }

    public get path(): typeof this.module._emscripten.PATH {
        return this.module._emscripten.PATH
    }
}
