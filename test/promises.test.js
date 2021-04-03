const { expect, test } = require('@jest/globals')
const { getEngine } = require('./utils')

jest.useFakeTimers()

test('asyncccc', async () => {
    const engine = await getEngine()
    const check = jest.fn()
    engine.global.set('check', check)
    const promise = new Promise(resolve => setTimeout(() => resolve(60), 10)
    )
    engine.global.set('promise', promise)

    engine.doString(`
        promise:next(check)
    `)

    expect(check).not.toBeCalled()
    jest.advanceTimersByTime(20)
    await promise;
    expect(check).toBeCalledWith(60)
})
