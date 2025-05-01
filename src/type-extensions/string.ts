import LuaTypeExtension from '../type-extension'
import Global from '../global'
import { LuaType } from '../types'
import Thread from '../thread'

class BasicStringExtension extends LuaTypeExtension<string> {
    public constructor(thread: Global) {
        super(thread, 'js_string')
    }

    public pushValue(thread: Thread, { target }: { target: unknown }): boolean {
        if (typeof target !== 'string') {
            return false
        }

        thread.lua.lua_pushstring(thread.address, target)
        return true
    }

    public isType(_thread: Thread, _index: number, type: number): boolean {
        return type === LuaType.String
    }

    public getValue(thread: Thread, index: number): string {
        return thread.lua.lua_tolstring(thread.address, index, null)
    }

    public close(): void {
        // Nothing to do
    }
}

export default function createTypeExtension(thread: Global): LuaTypeExtension<string> {
    return new BasicStringExtension(thread)
}
