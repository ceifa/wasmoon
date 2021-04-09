import { LuaEngineOptions } from './types'
import Lua from './engine'
import LuaWasm from './luawasm'

export default class LuaFactory {
    private cmodule?: LuaWasm

    public constructor(private customWasmUri?: string) {
        if (this.customWasmUri === undefined) {
            const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined'

            if (isBrowser) {
                this.customWasmUri = 'http://unpkg.com/wasmoon/dist/glue.wasm'
            }
        }
    }

    public async mountFile(path: string, content: string | ArrayBufferView): Promise<void> {
        await this.getModule()
        this.mountFileSync(path, content)
    }

    public mountFileSync(path: string, content: string | ArrayBufferView): void {
        if (!this.cmodule) {
            throw new Error("Module is not initialized, instead call 'mountFile' to ensure initialization")
        }

        const fileSep = path.lastIndexOf('/')
        const file = path.substr(fileSep + 1)
        const body = path.substr(0, path.length - file.length - 1)

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
                    this.cmodule.module.FS.mkdir(current)
                } catch (err) {
                    // ignore EEXIST
                }

                parent = current
            }
        }

        this.cmodule.module.FS.writeFile(path, content)
    }

    public async createEngine(options?: Partial<LuaEngineOptions>): Promise<Lua> {
        return new Lua(await this.getModule(), options)
    }

    public async getModule(): Promise<LuaWasm> {
        if (!this.cmodule) {
            this.cmodule = await LuaWasm.initialize(this.customWasmUri)
        }

        return this.cmodule
    }
}
