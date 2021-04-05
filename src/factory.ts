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
        const cmodule = await this.getModule()

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
                    cmodule.module.FS.mkdir(current)
                } catch (err) {
                    // ignore EEXIST
                }

                parent = current
            }
        }

        cmodule.module.FS.writeFile(path, content)
    }

    public async createEngine(openStandardLibs = true): Promise<Lua> {
        return new Lua(await this.getModule(), openStandardLibs)
    }

    private async getModule(): Promise<LuaWasm> {
        if (!this.cmodule) {
            this.cmodule = await LuaWasm.initialize(this.customWasmUri)
        }

        return this.cmodule
    }
}
