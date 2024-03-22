import Global from '../global'
import Thread from '../thread'
import TypeExtension from '../type-extension'

// A default extension that treats js null as lua nil
class DefaultNullTypeExtension extends TypeExtension<unknown> {
    constructor(thread: Global) {
        super(thread, 'js_null')
    }
    public getValue(): null {
        throw new Error('nil values should be converted by pushValue')
    }
    public pushValue(thread: Thread, decoration: any): boolean {
        if (decoration?.target !== null) {
            return false
        }
        thread.lua.lua_pushnil(thread.address)
        return true
    }
    public close(): void {}
}

export default function createTypeExtension(thread: Global): TypeExtension<null> {
    return new DefaultNullTypeExtension(thread)
}
