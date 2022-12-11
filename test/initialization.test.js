import { LuaFactory } from '../dist'
import { test } from '@jest/globals'

test('create engine should succeed', async () => {
    await new LuaFactory().createEngine()
})
