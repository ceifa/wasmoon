const { expect, test } = require('@jest/globals')
const { getEngine } = require("./utils")
const { Thread } = require('../dist')

jest.useFakeTimers();

test('receive lua table on JS function should succeed', async () => {
    const engine = await getEngine()
    engine.setGlobal('stringify', table => {
        return JSON.stringify(table)
    })

    engine.doString('value = stringify({ test = 1 })')

    expect(engine.getGlobal('value')).toBe(JSON.stringify({ test: 1 }))
})

test('get a global table inside a JS function called by lua should succeed', async () => {
    const engine = await getEngine()
    engine.setGlobal('t', { test: 1 })
    engine.setGlobal('test', () => {
        return engine.getGlobal('t')
    })

    const value = engine.doString('return test(2)')

    expect(value).toEqual({ test: 1 })
})

test('receive JS object on lua should succeed', async () => {
    const engine = await getEngine()

    engine.setGlobal('test', () => {
        return {
            aaaa: 1,
            bbb: 'hey',
            test() {
                return 22
            }
        }
    })
    const value = engine.doString('return test().test()')

    expect(value).toBe(22)
})

test('a lua error should throw on JS', async () => {
    const engine = await getEngine();

    expect(() => {
        engine.doString(`x -`)
    }).toThrow()
})

test('call a lua function from JS should succeed', async () => {
    const engine = await getEngine()

    engine.doString(`function sum(x, y) return x + y end`)
    const sum = engine.getGlobal('sum')

    expect(sum(10, 50)).toBe(60)
})

test('scheduled lua calls should succeed', async () => {
    const engine = await getEngine()
    engine.setGlobal('setInterval', setInterval)

    engine.doString(`
    test = 0
    setInterval(function()
        test = test + 1
    end, 100)
    `)
    jest.advanceTimersByTime(100 * 10)

    expect(engine.getGlobal('test')).toBe(10)
})

test('scheduled lua calls should fail silently if invalid', async () => {
    const engine = await getEngine()
    engine.setGlobal('setInterval', setInterval)
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    engine.doString(`
    test = 0
    setInterval(function()
        test = test + 1
    end, 100)
    `)
    
    jest.advanceTimersByTime(100 * 10)
    engine.close()

    expect(() => jest.advanceTimersByTime(100 * 10)).not.toThrow()
})

test('call lua function from JS passing an array argument should succeed', async () => {
    const engine = await getEngine()
    engine.registerStandardLib()

    const sum = engine.doString(`
    return function(arr)
        local sum = 0
        for k, v in ipairs(arr) do
            sum = sum + v
        end
        return sum
    end
    `)

    expect(sum([10, 50, 25])).toBe(85)
})

test('call a global function with multiple returns should succeed', async () => {
    const engine = await getEngine()

    engine.doString(`
    function f(x,y)
        return 1,x,y,"Hello World",{},function() end
    end
    `)

    const returns = engine.callGlobal('f', 10, 25)
    expect(returns).toHaveLength(6)
    expect(returns).toEqual(expect.arrayContaining([1, 10, 25, "Hello World", {}]))
})

test('get a lua thread should succeed', async () => {
    const engine = await getEngine()
    engine.registerStandardLib()

    const thread = engine.doString(`
    return coroutine.create(function()
        print("hey")
    end)
    `)

    expect(thread).toBeInstanceOf(Thread)
    expect(thread).not.toBe(0)
})