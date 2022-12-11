const { LuaFactory } = require('..')
const { test } = require('@jest/globals')

test('create engine should succeed', async () => {
    await new LuaFactory().createEngine()
})
