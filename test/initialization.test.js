const { expect, test } = require('@jest/globals')
const { Lua } = require('../dist')

test('create engine without initialize should throw', () => {
    expect(() => new Lua()).toThrow()
})

test('create engine without awaiting initialize should throw', () => {
    expect(() => {
        Lua.ensureInitialization()
        new Lua()
    }).toThrow()
})

test('create engine after initialize should succeed', () => {
    expect(async () => {
        await Lua.ensureInitialization()
        new Lua()
    }).not.toThrow()
})