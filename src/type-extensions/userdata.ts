import type LuaState from '../state'
import type Thread from '../thread'
import TypeExtension from '../type-extension'

/** What `opaque(value)` is pushed as: a reference Lua can hold and hand back, with no members. */
class UserdataTypeExtension extends TypeExtension<any> {
    public constructor(state: LuaState) {
        super(state, 'js_userdata')
        // Opaque: nothing but the box's own __gc.
        this.deferMetatable(() => ({}))
    }

    public push(thread: Thread, target: unknown): void {
        this.pushReference(thread, target)
    }
}

export default function createTypeExtension(state: LuaState): UserdataTypeExtension {
    return new UserdataTypeExtension(state)
}
export type { UserdataTypeExtension }
