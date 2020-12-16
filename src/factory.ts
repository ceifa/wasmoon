import Lua from "./engine"
import LuaWasm from "./luawasm"

export default class LuaFactory {
    constructor(private customWasmName: string) {
    }

    public async createEngine(openStandardLibs: boolean = true): Promise<Lua> {
        const module = new LuaWasm()
        await module.initialize(this.customWasmName)

        return new Lua(module, openStandardLibs)
    }
}