import LuaTypeExtension from '../type-extension'
import Global from '../global'
import Thread from '../thread'
import { Decoration } from '../decoration'
import { LuaType, PointerSize } from '../types'
import isUtf8 from 'isutf8'

type BinaryType = Uint8Array<ArrayBufferLike> | string

class BinaryStringExtension extends LuaTypeExtension<BinaryType> {
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

    public isType(_thread: Thread, _index: number, type: LuaType): boolean {
        return type === LuaType.String
    }

    public getValue(thread: Thread, index: number, _userdata?: unknown): BinaryType {
        const lenPtr = thread.lua.module._malloc(PointerSize)
        const bufferPtr = thread.lua.lua_ptr_tolstring(thread.address, index, lenPtr)
        const length = thread.lua.module.HEAPU32[lenPtr / Uint32Array.BYTES_PER_ELEMENT]
        thread.lua.module._free(lenPtr)

        const dataView = thread.lua.module.HEAPU8.subarray(bufferPtr, bufferPtr + length)

        if (isUtf8(dataView)) {
            const decoder = new TextDecoder('utf-8')
            const decodedString = decoder.decode(dataView)
            return decodedString
        }

        return dataView
    }

    public close(): void {
        // Nothing to do
    }
}

export default function createTypeExtension(thread: Global): LuaTypeExtension<BinaryType> {
    return new BinaryStringExtension(thread)
}
