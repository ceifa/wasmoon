const { expect, test } = require('@jest/globals')
const { LuaFactory } = require('../dist')

test('create engine should succeed', () => {
    expect(async () => {
        await new LuaFactory().createEngine()
    }).not.toThrow()
})
