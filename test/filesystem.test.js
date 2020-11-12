const { expect, test } = require('@jest/globals')
const { getEngine } = require("./utils")

test('mount a file and require inside lua should succeed', async () => {
    const engine = await getEngine()
    engine.registerStandardLib()
    engine.mountFile('test.lua', 'answerToLifeTheUniverseAndEverything = 42')

    engine.doString('require("test")')

    expect(engine.getGlobal('answerToLifeTheUniverseAndEverything')).toBe(42)
})

test('mount a file in a complex directory and require inside lua should succeed', async () => {
    const engine = await getEngine()
    engine.registerStandardLib()
    engine.mountFile('yolo/sofancy/test.lua', 'return 42')

    const value = engine.doString('return require("yolo/sofancy/test")')

    expect(value).toBe(42)
})

test('mount a init file and require the module inside lua should succeed', async () => {
    const engine = await getEngine()
    engine.registerStandardLib()
    engine.mountFile('hello/init.lua', 'return 42')

    const value = engine.doString('return require("hello")')

    expect(value).toBe(42)
})

test('require a file which is not mounted should throw', async () => {
    const engine = await getEngine()
    engine.registerStandardLib()

    expect(() => {
        engine.doString('require("nothing")')
    }).toThrow()
})