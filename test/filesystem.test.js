const { expect, test } = require('@jest/globals')
const { getEngine } = require("./utils")

test('lua require virtual file', async () => {
    const engine = await getEngine();
    engine.registerStandardLib();
    engine.mountFile('test.lua', 'answerToLifeTheUniverseAndEverything = 42')
    engine.doString('require("test")')
    expect(engine.getGlobal('answerToLifeTheUniverseAndEverything')).toBe(42)
})

test('lua require virtual file in a complex directory', async () => {
    const engine = await getEngine();
    engine.registerStandardLib();
    engine.mountFile('yolo/sofancy/test.lua', 'return 42')
    const value = engine.doString('return require("yolo/sofancy/test")')
    expect(value).toBe(42)
})

test('lua require init file', async () => {
    const engine = await getEngine();
    engine.registerStandardLib();
    engine.mountFile('yolo/init.lua', 'return 42')
    const value = engine.doString('return require("yolo")')
    expect(value).toBe(42)
})