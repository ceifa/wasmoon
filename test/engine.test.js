const { expect, test } = require('@jest/globals')
const { getEngine, getFactory } = require('./utils')
const { LuaThread, LuaReturn, decorate, decorateUserData, LuaLibraries } = require('../dist')

jest.useFakeTimers()

class TestClass {
    constructor(name) {
        this.name = name
    }

    getName() {
        return this.name
    }
}

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

    expect(value).toEqual({ test: 1 })
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

    expect(value).toBe(22)
})

test('receive JS object with circular references on lua should succeed', async () => {
    const engine = await getEngine()
    const obj = {
        hello: 'world',
    }
    obj.self = obj
    engine.global.set('obj', obj)

    const value = await engine.doString('return obj.self.self.self.hello')

    expect(value).toBe('world')
})

test('receive JS object with multiple circular references on lua should succeed', async () => {
    const engine = await getEngine()
    const obj1 = {
        hello: 'world',
    }
    obj1.self = obj1
    const obj2 = {
        hello: 'everybody',
    }
    obj2.self = obj2
    engine.global.set('obj', { obj1, obj2 })

    await engine.doString(`
        assert(obj.obj1.self.self.hello == "world")
        assert(obj.obj2.self.self.hello == "everybody")
    `)
})

test('receive JS object with null prototype on lua should succeed', async () => {
    const engine = await getEngine()
    const obj = Object.create(null)
    obj.hello = 'world'
    engine.global.set('obj', obj)

    const value = await engine.doString(`return obj.hello`)

    expect(value).toBe('world')
})

test('a lua error should throw on JS', async () => {
    const engine = await getEngine()

    await expect(engine.doString(`x -`)).rejects.toThrow()
})

test('call a lua function from JS should succeed', async () => {
    const engine = await getEngine()

    await engine.doString(`function sum(x, y) return x + y end`)
    const sum = engine.global.get('sum')

    expect(sum(10, 50)).toBe(60)
})

test('scheduled lua calls should succeed', async () => {
    const engine = await getEngine()
    engine.global.set('setInterval', setInterval)

    await engine.doString(`
    test = 0
    setInterval(function()
        test = test + 1
    end, 100)
    `)
    jest.advanceTimersByTime(100 * 10)

    expect(engine.global.get('test')).toBe(10)
})

test('scheduled lua calls should fail silently if invalid', async () => {
    const engine = await getEngine()
    engine.global.set('setInterval', setInterval)
    jest.spyOn(console, 'warn').mockImplementation(() => {
        // Nothing to do.
    })

    await engine.doString(`
    test = 0
    setInterval(function()
        test = test + 1
    end, 100)
    `)

    jest.advanceTimersByTime(100 * 10)
    engine.global.close()

    expect(() => jest.advanceTimersByTime(100 * 10)).not.toThrow()
})

test('call lua function from JS passing an array argument should succeed', async () => {
    const engine = await getEngine()

    const sum = await engine.doString(`
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

    await engine.doString(`
    function f(x,y)
        return 1,x,y,"Hello World",{},function() end
    end
    `)

    const returns = engine.global.call('f', 10, 25)
    expect(returns).toHaveLength(6)
    expect(returns).toEqual(expect.arrayContaining([1, 10, 25, 'Hello World', {}]))
})

test('get a lua thread should succeed', async () => {
    const engine = await getEngine()

    const thread = await engine.doString(`
    return coroutine.create(function()
        print("hey")
    end)
    `)

    expect(thread).toBeInstanceOf(LuaThread)
    expect(thread).not.toBe(0)
})

test('a JS error should pause lua execution', async () => {
    const engine = await getEngine()
    const check = jest.fn()
    engine.global.set('check', check)
    engine.global.set('throw', () => {
        throw new Error('expected error')
    })

    await expect(
        engine.doString(`
        throw()
        check()
    `),
    ).rejects.toThrow()
    expect(check).not.toBeCalled()
})

test('catch a JS error with pcall should succeed', async () => {
    const engine = await getEngine()
    const check = jest.fn()
    engine.global.set('check', check)
    engine.global.set('throw', () => {
        throw new Error('expected error')
    })

    await engine.doString(`
        local success, err = pcall(throw)
        assert(success == false)
        assert(tostring(err) == "Error: expected error")
        check()
    `)

    expect(check).toBeCalled()
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

test('table supported circular dependencies', async () => {
    const engine = await getEngine()

    const a = { name: 'a' }
    const b = { name: 'b' }
    b.a = a
    a.b = b

    engine.global.pushValue(a)
    const res = engine.global.getValue(-1)

    // Jest does not cope well with comparing these
    expect(res.b.a === res).toEqual(true)
})

test('wrap a js object (with metatable)', async () => {
    const engine = await getEngine()
    engine.global.set('TestClass', {
        create: (name) => {
            return decorate(
                {
                    instance: decorateUserData(new TestClass(name)),
                },
                {
                    metatable: {
                        __name: 'js_TestClass',
                        __index: (self, key) => {
                            if (key === 'name') {
                                return self.instance.getName()
                            }
                            return null
                        },
                    },
                },
            )
        },
    })

    const res = await engine.doString(`
        local instance = TestClass.create("demo name")
        return instance.name
    `)
    expect(res).toEqual('demo name')
})

test('wrap a js object using proxy', async () => {
    const engine = await getEngine()
    engine.global.set('TestClass', {
        create: (name) => new TestClass(name),
    })
    const res = await engine.doString(`
        local instance = TestClass.create("demo name 2")
        return instance:getName()
    `)
    expect(res).toEqual('demo name 2')
})

test('wrap a js object using proxy and apply metatable in lua', async () => {
    const engine = await getEngine()
    engine.global.set('TestClass', {
        create: (name) => new TestClass(name),
    })
    const res = await engine.doString(`
        local instance = TestClass.create("demo name 2")

        -- Based in the simple lua classes tutotial
        local Wrapped = {}
        Wrapped.__index = Wrapped

        function Wrapped:create(name)
            local wrapped = {}
            wrapped.instance = TestClass.create(name)
            setmetatable(wrapped, Wrapped)
            return wrapped
        end

        function Wrapped:getName()
            return "wrapped: "..self.instance:getName()
        end

        local wr = Wrapped:create("demo")
        return wr:getName()
    `)
    expect(res).toEqual('wrapped: demo')
})

test('classes should be a userdata when proxied', async () => {
    const engine = await getEngine()
    engine.global.set('obj', { TestClass })

    const testClass = await engine.doString(`
        return obj.TestClass
    `)

    expect(testClass).toBe(TestClass)
})

test('timeout blocking lua program', async () => {
    const engine = await getEngine()
    const thread = engine.global.newThread()

    thread.loadString(`
        local i = 0
        while true do i = i + 1 end
    `)

    await expect(thread.run(0, { timeout: 5, forcedYieldCount: 1000 })).rejects.toThrow('run exceeded timeout of 5ms')
})

test('overwrite lib function', async () => {
    const engine = await getEngine()

    let output = ''
    engine.global.getTable(LuaLibraries.Base, (index) => {
        engine.global.setField(index, 'print', (val) => {
            // Not a proper print implementation.
            output += `${val}\n`
        })
    })

    await engine.doString(`
        print("hello")
        print("world")
    `)

    expect(output).toEqual('hello\nworld\n')
})

test('inject a userdata with a metatable should succeed', async () => {
    const engine = await getEngine()
    const obj = decorate(
        {},
        {
            metatable: { __index: (t, k) => `Hello ${k}!` },
        },
    )
    engine.global.set('obj', obj)

    const res = await engine.doString('return obj.World')

    expect(res).toEqual('Hello World!')
})

test('a userdata should be collected', async () => {
    const engine = await getEngine()
    const obj = {}
    engine.global.set('obj', obj)
    const oldRef = engine.global.lua.getRef(1)

    await engine.doString(`
        local weaktable = {}
        setmetatable(weaktable, { __mode = "v" })
        table.insert(weaktable, obj)
        obj = nil
        collectgarbage()
        assert(next(weaktable) == nil)
    `)

    expect(oldRef).toEqual(obj)
    const newRef = engine.global.lua.getRef(1)
    expect(newRef).toEqual(undefined)
})

test('environment variables should be set', async () => {
    const factory = getFactory({ TEST: 'true' })
    const engine = await factory.createEngine()

    const testEnvVar = await engine.doString(`return os.getenv('TEST')`)

    expect(testEnvVar).toEqual('true')
})
