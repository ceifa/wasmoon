const { expect, test } = require('@jest/globals')
const { getEngine } = require("./utils")

test('receive table on JS function', async () => {
    const engine = await getEngine();
    engine.setGlobal('stringify', table => {
        return JSON.stringify(table);
    })
    engine.doString('value = stringify({ test = 1 })')
    expect(engine.getGlobal('value')).toBe(JSON.stringify({ test: 1 }))
})

test('get table inside a JS function called by lua', async () => {
    const engine = await getEngine();
    engine.setGlobal('t', { test: 1 })
    engine.setGlobal('test', () => {
        return engine.getGlobal('t')
    })
    const value = engine.doString('return test(2)')
    expect(value).toEqual({ test: 1 })
})