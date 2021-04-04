const { expect, test } = require('@jest/globals')
const { getFactory, getEngine } = require('./utils')

test('mount a file and require inside lua should succeed', async () => {
    const factory = getFactory()
    await factory.mountFile('test.lua', 'answerToLifeTheUniverseAndEverything = 42')
    const engine = await factory.createEngine()

    await engine.doString('require("test")')

    expect(engine.global.get('answerToLifeTheUniverseAndEverything')).toBe(42)
})

test('mount a file in a complex directory and require inside lua should succeed', async () => {
    const factory = getFactory()
    await factory.mountFile('yolo/sofancy/test.lua', 'return 42')
    const engine = await factory.createEngine()

    const value = await engine.doString('return require("yolo/sofancy/test")')

    // Require returns the resolution method.
    expect(value).toEqual([42, './yolo/sofancy/test.lua'])
})

test('mount a init file and require the module inside lua should succeed', async () => {
    const factory = getFactory()
    await factory.mountFile('hello/init.lua', 'return 42')
    const engine = await factory.createEngine()

    const value = await engine.doString('return require("hello")')

    expect(value).toEqual([42, './hello/init.lua'])
})

test('require a file which is not mounted should throw', async () => {
    const engine = await getEngine()

    await expect(engine.doString('require("nothing")')).rejects.toThrow()
})

test('mount a file and run it should succeed', async () => {
    const factory = getFactory()
    const engine = await factory.createEngine()

    await factory.mountFile('init.lua', `return 42`)
    const value = await engine.doFile('init.lua')

    expect(value).toEqual([42])
})

test('run a file which is not mounted should throw', async () => {
    const engine = await getEngine()

    await expect(engine.doFile('init.lua')).rejects.toThrow()
})
