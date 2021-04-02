import Lua from './engine'
import LuaWasm from './luawasm'

export default class LuaFactory {
    private module?: LuaWasm

    public constructor(private customWasmUri?: string) {
        if (this.customWasmUri === undefined) {
            const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined'

            if (isBrowser) {
                this.customWasmUri = 'http://unpkg.com/wasmoon/dist/glue.wasm'
            }
        }
    }

    public async createEngine(openStandardLibs = true): Promise<Lua> {
        if (!this.module) {
            this.module = await LuaWasm.initialize(this.customWasmUri)
        }

        return new Lua(this.module, openStandardLibs)
    }
}
