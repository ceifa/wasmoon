import type { Decoration } from '../decoration'
import type LuaState from '../state'
import type Thread from '../thread'
import TypeExtension from '../type-extension'

class UserdataTypeExtension extends TypeExtension<any> {
    public constructor(state: LuaState) {
        super(state, 'js_userdata')
        // Opaque: nothing but the box's own __gc.
        this.defineMetatable()
    }

    public getValue(thread: Thread, index: number): any {
        // isType has already matched the metatable, so the check is not paid for again here.
        return thread.module.getReferenceBox(thread.address, index)
    }

    public pushValue(thread: Thread, decoratedValue: Decoration<unknown>): boolean {
        if (decoratedValue.options.as !== 'userdata') {
            return false
        }

        return super.pushValue(thread, decoratedValue)
    }
}

export default function createTypeExtension(state: LuaState): TypeExtension<any> {
    return new UserdataTypeExtension(state)
}
