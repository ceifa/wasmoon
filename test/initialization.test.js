const { test } = require('@jest/globals')
const { LuaFactory } = require('../dist')

test('create engine should succeed', async () => {
    await new LuaFactory().createEngine()
})
