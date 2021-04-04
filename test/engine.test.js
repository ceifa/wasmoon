const { expect, test } = require('@jest/globals')
const { getEngine } = require('./utils')
const { Thread, LuaReturn } = require('../dist')

jest.useFakeTimers()

test('receive lua table on JS function should succeed', async () => {
    const engine = await getEngine()
    engine.global.set('stringify', (table) => {
        return JSON.stringify(table)
    })

    await engine.doString('value = stringify({ test = 1 })')

    expect(engine.global.get('value')).toBe(JSON.stringify({ test: 1 }))
})

test('get a global table inside a JS function called by lua should succeed', async () => {
    const engine = await getEngine()
    engine.global.set('t', { test: 1 })
    engine.global.set('test', () => {
        return engine.global.get('t')
    })

    const value = await engine.doString('return test(2)')

    expect(value).toEqual([{ test: 1 }])
})

test('receive JS object on lua should succeed', async () => {
    const engine = await getEngine()

    engine.global.set('test', () => {
        return {
            aaaa: 1,
            bbb: 'hey',
            test() {
                return 22
            },
        }
    })
    const value = await engine.doString('return test().test()')

    expect(value).toEqual([22])
})

test('a lua error should throw on JS', async () => {
    const engine = await getEngine()

    await expect(engine.doString(`x -`)).rejects.toThrow()
})

test('call a lua function from JS should succeed', async () => {
    const engine = await getEngine()

    await engine.doString(`function sum(x, y) return x + y end`)
    const sum = engine.global.get('sum')

    expect(await sum(10, 50)).toEqual([60])
})

test('scheduled lua calls should succeed', async () => {
    const engine = await getEngine()
    engine.global.set('setInterval', setInterval)

    const [interval] = await engine.doString(`
    test = 0
    return setInterval(function()
        test = test + 1
    end, 100)
    `)
    jest.advanceTimersByTime(100 * 10)
    clearInterval(interval)

    expect(engine.global.get('test')).toBe(10)
})

test('scheduled lua calls should fail silently if invalid', async () => {
    const engine = await getEngine()
    engine.global.set('setInterval', setInterval)
    jest.spyOn(console, 'warn').mockImplementation(() => {
        // Nothing to do.
    })

    const [interval] = await engine.doString(`
    test = 0
    return setInterval(function()
        test = test + 1
    end, 100)
    `)

    jest.advanceTimersByTime(100 * 10)
    engine.global.close()

    expect(() => jest.advanceTimersByTime(100 * 10)).not.toThrow()

    clearInterval(interval)
})

test('call lua function from JS passing an array argument should succeed', async () => {
    const engine = await getEngine()

    const [sum] = await engine.doString(`
    return function(arr)
        local sum = 0
        for k, v in ipairs(arr) do
            sum = sum + v
        end
        return sum
    end
    `)

    const sumResult = await sum([10, 50, 25])

    expect(sumResult).toEqual([85])
})

test('call a global function with multiple returns should succeed', async () => {
    const engine = await getEngine()

    await engine.doString(`
    function f(x,y)
        return 1,x,y,"Hello World",{},function() end
    end
    `)

    const returns = await engine.global.call('f', 10, 25)
    expect(returns).toHaveLength(6)
    expect(returns).toEqual(expect.arrayContaining([1, 10, 25, 'Hello World', {}]))
})

test('get a lua thread should succeed', async () => {
    const engine = await getEngine()

    const [thread] = await engine.doString(`
    return coroutine.create(function()
        print("hey")
    end)
    `)

    expect(thread).toBeInstanceOf(Thread)
    expect(thread).not.toBe(0)
})

test('call a JS function in a different thread should succeed', async () => {
    const engine = await getEngine()
    const sum = jest.fn((x, y) => x + y)
    engine.global.set('sum', sum)

    await engine.doString(`
    coroutine.resume(coroutine.create(function()
        sum(10, 20)
    end))
    `)

    expect(sum).toBeCalledWith(10, 20)
})

test('lua_resume with yield succeeds', async () => {
    const engine = await getEngine()
    const thread = engine.global.newThread()
    thread.loadString(`
        local yieldRes = coroutine.yield(10)
        return yieldRes
    `)

    const resumeResult = thread.resume(0)
    expect(resumeResult.result).toEqual(LuaReturn.Yield)
    expect(resumeResult.resultCount).toEqual(1)

    const yieldValue = thread.getValue(-1)
    expect(yieldValue).toEqual(10)

    thread.pop(resumeResult.resultCount)
    thread.pushValue(yieldValue * 2)

    const finalResumeResult = thread.resume(1)
    expect(finalResumeResult.result).toEqual(LuaReturn.Ok)
    expect(finalResumeResult.resultCount).toEqual(1)

    const finalValue = thread.getValue(-1)
    expect(finalValue).toEqual(20)
})

test('lua_resume with async yield callback', async () => {
    const engine = await getEngine()
    const thread = engine.global.newThread()

    thread.set('asyncCallback', async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return Promise.resolve(input * 2)
    })

    thread.loadString(`
        local result = asyncCallback(15)
        return result
    `)

    const resumeResult = thread.resume(0)
    expect(resumeResult.result).toEqual(LuaReturn.Yield)
    expect(resumeResult.resultCount).toEqual(1)

    const yieldValue = thread.getValue(-1)
    thread.pop(resumeResult.resultCount)
    if (Promise.resolve(yieldValue) !== yieldValue) {
        throw new Error('expected a promise')
    }

    jest.runOnlyPendingTimers()
    await yieldValue

    const finalResumeResult = thread.resume(0)
    expect(finalResumeResult.result).toEqual(LuaReturn.Ok)
    expect(finalResumeResult.resultCount).toEqual(1)

    const finalValue = thread.getValue(-1)
    expect(finalValue).toEqual(30)
})

test('run with async callback', async () => {
    const engine = await getEngine()
    const thread = engine.global.newThread()

    thread.set('asyncCallback', async (input) => {
        return Promise.resolve(input * 2)
    })
    thread.loadString(`
        local input = ...
        assert(type(input) == "number")
        assert(type(asyncCallback) == "function")
        local result1 = asyncCallback(input)
        local result2 = asyncCallback(result1)
        return result2
    `)
    thread.pushValue(3)
    const resumeResult = await thread.run(1)
    expect(resumeResult.result).toEqual(LuaReturn.Ok)
    expect(resumeResult.resultCount).toEqual(1)

    const finalValue = thread.getValue(-1)
    expect(finalValue).toEqual(3 * 2 * 2)
})

test('get memory use succeeds', async () => {
    const engine = await getEngine()
    expect(engine.global.getMemoryUsed()).toBeGreaterThan(0)
})

test('limit memory use causes program loading failure succeeds', async () => {
    const engine = await getEngine()
    engine.global.setMemoryMax(engine.global.getMemoryUsed())
    expect(() => {
        engine.global.loadString(`
            local a = 10
            local b = 20
            return a + b
        `)
    }).toThrow('Lua Error(ErrorMem/4): not enough memory')

    // Remove the limit and retry
    engine.global.setMemoryMax(undefined)
    engine.global.loadString(`
        local a = 10
        local b = 20
        return a + b
    `)
})

test('limit memory use causes program runtime failure succeeds', async () => {
    const engine = await getEngine()
    engine.global.loadString(`
        local tab = {}
        for i = 1, 10, 1 do
            tab[i] = i
        end
    `)
    engine.global.setMemoryMax(engine.global.getMemoryUsed())

    await expect(engine.global.run()).rejects.toThrow('Lua Error(ErrorMem/4): not enough memory')
})
