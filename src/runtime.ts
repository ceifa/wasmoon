import LuaModule, { type EmscriptenFS, type EmscriptenPath, type LuaModuleOptions } from './module'
import LuaState from './state'
import type { CreateStateOptions } from './types'

/**
 * One loaded Lua wasm module, and the factory for the states that run on it.
 *
 * States created from the same runtime share the filesystem and the module level stdio, and are
 * otherwise independent.
 */
export default class LuaRuntime {
    /** Loads the Lua wasm module. Stdio and the filesystem are shared by every state on it. */
    public static async load(luaModuleOpts: Readonly<LuaModuleOptions> = {}): Promise<LuaRuntime> {
        return new LuaRuntime(await LuaModule.initialize(luaModuleOpts))
    }

    private readonly states = new Set<LuaState>()

    public constructor(public readonly module: LuaModule) {}

    public createState(stateOpts: CreateStateOptions = {}): LuaState {
        const state = new LuaState(this.module, stateOpts)
        this.states.add(state)
        state.onClose(() => this.states.delete(state))
        return state
    }

    /**
     * Closes every state created from this runtime. The wasm module itself cannot be unloaded, so
     * this frees the states rather than the runtime.
     */
    public close(): void {
        for (const state of this.states) {
            state.close()
        }
        this.states.clear()
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        this.close()
    }

    /**
     * Writes a file into the Lua environment, creating its directories as needed.
     * @param path - Path to the file in the Lua environment.
     * @param content - Content of the file to be mounted.
     */
    public mountFile(path: string, content: string | ArrayBufferView): void {
        this.filesystem.mkdirTree(this.path.dirname(path))
        this.filesystem.writeFile(path, content)
    }

    public get filesystem(): EmscriptenFS {
        return this.module.emscripten.FS
    }

    public get path(): EmscriptenPath {
        return this.module.emscripten.PATH
    }
}
