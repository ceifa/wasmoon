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
     * Writes a file the Lua states can read, creating its directories as needed. A relative path is
     * resolved against {@link cwd}.
     *
     * With `fs: 'host'`, and inside a mount, this writes to the real filesystem.
     */
    public writeFile(path: string, content: string | ArrayBufferView): void {
        // Only when it is missing: mkdirTree walks every level and finds out by way of a thrown
        // EEXIST, which costs several times the write itself once the directory is there -- and a
        // real syscall per level with `fs: 'host'`.
        const parent = this.path.dirname(path)
        if (!this.exists(parent)) {
            this.filesystem.mkdirTree(parent)
        }
        this.filesystem.writeFile(path, content)
    }

    /** The bytes of a file, for content that is not text. */
    public readFile(path: string): Uint8Array {
        return this.filesystem.readFile(path)
    }

    /** A file decoded as UTF-8, with invalid bytes replaced by U+FFFD. */
    public readTextFile(path: string): string {
        return this.filesystem.readFile(path, { encoding: 'utf8' })
    }

    public exists(path: string): boolean {
        return this.filesystem.analyzePath(path).exists
    }

    /** Where relative paths resolve from, `/` unless something changed it or `fs` is `'host'`. */
    public cwd(): string {
        return this.filesystem.cwd()
    }

    /** With `fs: 'host'` this moves the Node process itself, since there is only one working directory. */
    public chdir(path: string): void {
        this.filesystem.chdir(path)
    }

    /** See {@link LuaModuleOptions.mounts}, whose entries this is the after-the-fact equivalent of. */
    public mount(virtualPath: string, hostPath: string): void {
        this.module.mount(virtualPath, hostPath)
    }

    /** See {@link LuaModule.unmount}. */
    public unmount(virtualPath: string): void {
        this.module.unmount(virtualPath)
    }

    /** Emscripten's own filesystem API, for everything the methods above do not cover. */
    public get filesystem(): EmscriptenFS {
        return this.module.emscripten.FS
    }

    public get path(): EmscriptenPath {
        return this.module.emscripten.PATH
    }
}
