import LuaTypeExtension from '../type-extension'
import Global from '../global'
import Thread from '../thread'
import { Decoration } from '../decoration'

export class Uint8ArrayExtension extends LuaTypeExtension<unknown> {
    constructor(thread: Global) {
        super(thread, 'js_unit8array')
    }

    public pushValue(thread: Thread, { target }: Decoration<Uint8Array>): boolean {
        if (target instanceof Uint8Array) {
            thread.lua.lua_checkstack(thread.address, 1)
            const bufferSize = target.byteLength
            const bufferPtr = thread.lua.module._malloc(bufferSize)

            thread.lua.module.HEAP8.set(target, bufferPtr)
            thread.lua.lua_pushlstring(thread.address, bufferPtr, bufferSize)
            thread.lua.module._free(bufferPtr)

            return true
        }

        return false
    }

    public close(): void {
        // Nothing to do
    }
}
