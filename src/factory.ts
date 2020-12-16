import Lua from "./engine"
import LuaWasm from "./luawasm"

export default class LuaFactory {
    private module: LuaWasm

    constructor(private customWasmName: string) {
    }

    public async createEngine(openStandardLibs: boolean = true): Promise<Lua> {
        if (!this.module) {
            this.module = new LuaWasm()
            await this.module.initialize(this.customWasmName)
        }

        return new Lua(this.module, openStandardLibs)
    }
}