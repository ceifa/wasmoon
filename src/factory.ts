import Lua from "./engine"
import LuaWasm from "./luawasm"

export default class LuaFactory {
    private module: LuaWasm

    constructor(private customWasmUri: string = undefined) {
        if (this.customWasmUri === undefined) {
            const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined'

            if (isBrowser) {
                this.customWasmUri = 'http://unpkg.com/wasmoon/dist/glue.wasm'
            }
        }
    }

    public async createEngine(openStandardLibs: boolean = true): Promise<Lua> {
        if (!this.module) {
            this.module = new LuaWasm()
            await this.module.initialize(this.customWasmUri)
        }

        return new Lua(this.module, openStandardLibs)
    }
}