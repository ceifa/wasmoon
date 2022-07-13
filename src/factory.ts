import { EnvironmentVariables } from './types'
import { version } from '../package.json'
import LuaEngine from './engine'
import LuaWasm from './luawasm'

export default class LuaFactory {
    // Promises always resolve to the same thing.
    // Need to do it like this because otherwise if the caller calls createEngine multiple times before yielding
    // they'll end up with multiple wasm initialisations.
    private luaWasmPromise = LuaWasm.initialize(this.customWasmUri, this.environmentVariables)

    public constructor(private readonly customWasmUri?: string, private readonly environmentVariables?: EnvironmentVariables) {
        if (this.customWasmUri === undefined) {
            const isBrowser =
                (typeof window === 'object' && typeof window.document !== 'undefined') ||
                (typeof self === 'object' && self?.constructor?.name === 'DedicatedWorkerGlobalScope')

            if (isBrowser) {
                const majorminor = version.slice(0, version.lastIndexOf('.'))
                this.customWasmUri = `http://unpkg.com/wasmoon@${majorminor}/dist/glue.wasm`
            }
        }
    }

    public async mountFile(path: string, content: string | ArrayBufferView): Promise<void> {
        this.mountFileSync(await this.getLuaModule(), path, content)
    }

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

    public async createEngine(options: ConstructorParameters<typeof LuaEngine>[1] = {}): Promise<LuaEngine> {
        return new LuaEngine(await this.getLuaModule(), options)
    }

    public async getLuaModule(): Promise<LuaWasm> {
        return this.luaWasmPromise
    }
}
