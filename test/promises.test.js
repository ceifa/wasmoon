const { expect, test } = require('@jest/globals')
const { getEngine, tick } = require('./utils')

jest.useFakeTimers()

test('use promise next should succeed', async () => {
    const engine = await getEngine()
    const check = jest.fn()
    engine.global.set('check', check)
    const promise = new Promise((resolve) => setTimeout(() => resolve(60), 10))
    engine.global.set('promise', promise)

    const res = engine.doString(`
        promise:next(check)
    `)

    expect(check).not.toBeCalled()
    jest.advanceTimersByTime(20)
    await promise
    await res
    expect(check).toBeCalledWith(60)
})

test('chain promises with next should succeed', async () => {
    const engine = await getEngine()
    const check = jest.fn()
    engine.global.set('check', check)
    const promise = new Promise((resolve) => resolve(60))
    engine.global.set('promise', promise)

    const res = engine.doString(`
        promise:next(function(value)
            return value * 2
        end):next(check):next(check)
    `)

    await promise
    await tick()
    await res

    expect(check).toBeCalledWith(120)
    expect(check).toBeCalledTimes(2)
})

test('call an async function should succeed', async () => {
    const engine = await getEngine()
    engine.global.set('asyncFunction', async () => Promise.resolve(60))
    const check = jest.fn()
    engine.global.set('check', check)

    const res = engine.doString(`
        asyncFunction():next(check)
    `)

    await tick()
    await res
    expect(check).toBeCalledWith(60)
})

test('return an async function should succeed', async () => {
    const engine = await getEngine()
    engine.global.set('asyncFunction', async () => Promise.resolve(60))

    const asyncFunction = await engine.doString(`
        return asyncFunction
    `)
    const value = await asyncFunction()

    expect(value).toBe(60)
})

test('return a chained promise should succeed', async () => {
    const engine = await getEngine()
    engine.global.set('asyncFunction', async () => Promise.resolve(60))

    const asyncFunction = await engine.doString(`
        return asyncFunction():next(function(x) return x * 2 end)
    `)
    const value = await asyncFunction

    expect(value).toBe(120)
})

test('await an promise inside coroutine should succeed', async () => {
    const engine = await getEngine()
    const check = jest.fn()
    engine.global.set('check', check)
    const promise = new Promise((resolve) => setTimeout(() => resolve(60), 10))
    engine.global.set('promise', promise)

    const res = engine.doString(`
        local co = coroutine.create(function()
            local value = promise:await()
            check(value)
        end)

        while coroutine.status(co) == "suspended" do
            local success, res = coroutine.resume(co)
            -- yield to allow promises to resolve
            -- this yields on the promise returned by the above
            coroutine.yield(res)
        end
    `)

    expect(check).not.toBeCalled()
    jest.advanceTimersByTime(20)
    await promise
    await res
    expect(check).toBeCalledWith(60)
})

test('awaited coroutines should ignore resume until it resolves the promise', async () => {
    const engine = await getEngine()
    const check = jest.fn()
    engine.global.set('check', check)
    const promise = new Promise((resolve) => setTimeout(() => resolve(60), 10))
    engine.global.set('promise', promise)

    const res = engine.doString(`
        local co = coroutine.create(function()
            local value = promise:await()
            check(value)
        end)
        while coroutine.status(co) == "suspended" do
            coroutine.resume(co)
            -- yields for a tick
            coroutine.yield()
        end
    `)

    expect(check).not.toBeCalled()
    jest.advanceTimersByTime(20)
    await promise
    await res
    expect(check).toBeCalledWith(60)
})

test('await a thread run with async calls should succeed', async () => {
    const engine = await getEngine()
    engine.global.set('sleep', (input) => new Promise((resolve) => setTimeout(resolve, input)))
    const asyncThread = engine.global.newThread()

    asyncThread.loadString(`
        sleep(1):await()
        return 50
    `)

    const asyncFunctionPromise = asyncThread.run()
    jest.runAllTimers()
    expect(await asyncFunctionPromise).toEqual([50])
})

test('run thread with async calls and yields should succeed', async () => {
    const engine = await getEngine()
    engine.global.set('sleep', (input) => new Promise((resolve) => setTimeout(resolve, input)))
    const asyncThread = engine.global.newThread()

    asyncThread.loadString(`
        coroutine.yield()
        sleep(1):await()
        coroutine.yield()
        return 50
    `)

    const asyncFunctionPromise = asyncThread.run()
    // Wait 1 tick for the initial yield
    await tick()
    // Allow the timer to progress
    jest.runAllTimers()
    expect(await asyncFunctionPromise).toEqual([50])
})

test('reject a promise should succeed', async () => {
    const engine = await getEngine()
    engine.global.set('throw', () => new Promise((_, reject) => reject(new Error('expected test error'))))
    const asyncThread = engine.global.newThread()

    asyncThread.loadString(`
        throw():await()
        error("this should not be reached")
    `)

    await expect(() => asyncThread.run()).rejects.toThrow('expected test error')
})

test('pcall a promise await should succeed', async () => {
    const engine = await getEngine()
    engine.global.set('throw', () => new Promise((_, reject) => reject(new Error('expected test error'))))
    const asyncThread = engine.global.newThread()

    asyncThread.loadString(`
        local succeed, err = pcall(function() throw():await() end)
        assert(tostring(err) == "Error: expected test error")
        return succeed
    `)

    expect(await asyncThread.run()).toEqual([false])
})

test('catch a promise rejection should succeed', async () => {
    const engine = await getEngine()
    const fulfilled = jest.fn()
    const rejected = jest.fn()
    engine.global.set('handlers', { fulfilled, rejected })
    engine.global.set('throw', new Promise((_, reject) => reject(new Error('expected test error'))))

    const res = engine.doString(`
        throw:next(handlers.fulfilled, handlers.rejected):catch(function() end)
    `)

    await tick()
    await res
    expect(fulfilled).not.toBeCalled()
    expect(rejected).toBeCalled()
})

test('run with async callback', async () => {
    const engine = await getEngine()
    const thread = engine.global.newThread()

    engine.global.set('asyncCallback', async (input) => {
        return Promise.resolve(input * 2)
    })

    thread.loadString(`
        local input = ...
        assert(type(input) == "number")
        assert(type(asyncCallback) == "function")
        local result1 = asyncCallback(input):await()
        local result2 = asyncCallback(result1):await()
        return result2
    `)

    thread.pushValue(3)
    const [finalValue] = await thread.run(1)

    expect(finalValue).toEqual(3 * 2 * 2)
})

test('promise creation from js', async () => {
    const engine = await getEngine()
    const res = await engine.doString(`
        local promise = Promise.create(function (resolve)
            resolve(10)
        end)
        local nested = promise:next(function (value)
            return Promise.create(function (resolve2)
                resolve2(value * 2)
            end)
        end)
        return nested:await()
    `)
    expect(res).toEqual(20)
})

test('reject promise creation from js', async () => {
    const engine = await getEngine()
    const res = await engine.doString(`
        local rejection = Promise.create(function (resolve, reject)
            reject("expected rejection")
        end)
        return rejection:catch(function (err)
            return err
        end):await()
    `)
    expect(res).toEqual('expected rejection')
})

test('resolve multiple promises with promise.all', async () => {
    const engine = await getEngine()
    engine.global.set('sleep', (input) => new Promise((resolve) => setTimeout(resolve, input)))
    const resPromise = engine.doString(`
        local promises = {}
        for i = 1, 10 do
            table.insert(promises, sleep(50):next(function ()
                return i
            end))
        end
        return Promise.all(promises):await()
    `)
    jest.advanceTimersByTime(50)
    const res = await resPromise

    expect(res).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
})

test('error in promise next catchable', async () => {
    const engine = await getEngine()
    engine.global.set('sleep', (input) => new Promise((resolve) => setTimeout(resolve, input)))
    const resPromise = engine
        .doString(
            `
        return sleep(1):next(function ()
            error("sleep done")
        end):await()
    `,
        )
        .catch((err) => {
            expect(err.message).toContain('[string "..."]:3: sleep done')
        })
    jest.advanceTimersByTime(50)
    await resPromise
})
