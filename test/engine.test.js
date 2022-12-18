const { LuaLibraries, LuaReturn, LuaThread, LuaType, decorate, decorateProxy, decorateUserdata } = require('..')
const { expect, test } = require('@jest/globals')
const { getEngine, getFactory } = require('./utils')

jest.useFakeTimers({ legacyFakeTimers: true })

class TestClass {
    static hello() {
        return 'world'
    }

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

test('receive Lua object with circular references on JS should succeed', async () => {
    const engine = await getEngine()
    const value = await engine.doString(`
        local obj1 = {
            hello = 'world',
        }
        obj1.self = obj1
        local obj2 = {
            5,
            hello = 'everybody',
            array = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
            fn = function()
                return 'hello'
            end
        }
        obj2.self = obj2
        return { obj1 = obj1, obj2 }
    `)

    expect(value).toMatchObject({
        obj1: {
            hello: 'world',
        },
        1: {
            1: 5,
            hello: 'everybody',
            array: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
            fn: expect.any(Function),
        },
    })
})

test('receive lua array with circular references on JS should succeed', async () => {
    const engine = await getEngine()
    const value = await engine.doString(`
        obj = {
            "hello",
            "world"
        }
        table.insert(obj, obj)
        return obj
    `)

    expect(value).toMatchObject(['hello', 'world', ['hello', 'world']])
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

test('get callable table as function should succeed', async () => {
    const engine = await getEngine()
    await engine.doString(`
        _G['sum'] = setmetatable({}, {
            __call = function(self, x, y)
                return x + y
            end
        })
    `)

    engine.global.lua.lua_getglobal(engine.global.address, 'sum')
    const sum = engine.global.getValue(-1, LuaType.Function)

    expect(sum(10, 30)).toBe(40)
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

test('get memory with allocation tracing should succeeds', async () => {
    const engine = await getEngine({ traceAllocations: true })
    expect(engine.global.getMemoryUsed()).toBeGreaterThan(0)
})

test('get memory should return correct', async () => {
    const engine = await getEngine({ traceAllocations: true })

    const totalMemory = await engine.doString(`
        collectgarbage()
        local x = 10
        local batata = { dawdwa = 1 }
        return collectgarbage('count') * 1024
    `)

    expect(engine.global.getMemoryUsed()).toBe(totalMemory)
})

test('get memory without tracing should throw', async () => {
    const engine = await getEngine({ traceAllocations: false })

    expect(() => engine.global.getMemoryUsed()).toThrow()
})

test('limit memory use causes program loading failure succeeds', async () => {
    const engine = await getEngine({ traceAllocations: true })
    engine.global.setMemoryMax(engine.global.getMemoryUsed())
    expect(() => {
        engine.global.loadString(`
            local a = 10
            local b = 20
            return a + b
        `)
    }).toThrow('not enough memory')

    // Remove the limit and retry
    engine.global.setMemoryMax(undefined)
    engine.global.loadString(`
        local a = 10
        local b = 20
        return a + b
    `)
})

test('limit memory use causes program runtime failure succeeds', async () => {
    const engine = await getEngine({ traceAllocations: true })
    engine.global.loadString(`
        local tab = {}
        for i = 1, 50, 1 do
            tab[i] = i
        end
    `)
    engine.global.setMemoryMax(engine.global.getMemoryUsed())

    await expect(engine.global.run()).rejects.toThrow('not enough memory')
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
                    instance: decorateUserdata(new TestClass(name)),
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

    await expect(thread.run(0, { timeout: 5 })).rejects.toThrow('thread timeout exceeded')
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
            metatable: { __index: (_, k) => `Hello ${k}!` },
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
    const refIndex = engine.global.lua.getLastRefIndex()
    const oldRef = engine.global.lua.getRef(refIndex)

    await engine.doString(`
        local weaktable = {}
        setmetatable(weaktable, { __mode = "v" })
        table.insert(weaktable, obj)
        obj = nil
        collectgarbage()
        assert(next(weaktable) == nil)
    `)

    expect(oldRef).toEqual(obj)
    const newRef = engine.global.lua.getRef(refIndex)
    expect(newRef).toEqual(undefined)
})

test('environment variables should be set', async () => {
    const factory = getFactory({ TEST: 'true' })
    const engine = await factory.createEngine()

    const testEnvVar = await engine.doString(`return os.getenv('TEST')`)

    expect(testEnvVar).toEqual('true')
})

test('static methods should be callable on classes', async () => {
    const engine = await getEngine()
    engine.global.set('TestClass', TestClass)

    const testHello = await engine.doString(`return TestClass.hello()`)

    expect(testHello).toEqual('world')
})

test('should be possible to access function properties', async () => {
    const engine = await getEngine()
    const testFunction = () => undefined
    testFunction.hello = 'world'
    engine.global.set('TestFunction', decorateProxy(testFunction, { proxy: true }))

    const testHello = await engine.doString(`return TestFunction.hello`)

    expect(testHello).toEqual('world')
})

test('throw error includes stack trace', async () => {
    const engine = await getEngine()
    try {
        await engine.doString(`
            local function a()
                error("function a threw error")
            end
            local function b() a() end
            local function c() b() end
            c()
        `)
        throw new Error('should not be reached')
    } catch (err) {
        expect(err.message.includes('[string "..."]:3: function a threw error')).toEqual(true)
        expect(err.message.includes('stack traceback:')).toEqual(true)
        expect(err.message.includes(`[string "..."]:3: in upvalue 'a'`)).toEqual(true)
        expect(err.message.includes(`[string "..."]:5: in upvalue 'b'`)).toEqual(true)
        expect(err.message.includes(`[string "..."]:6: in local 'c'`)).toEqual(true)
        expect(err.message.includes(`[string "..."]:7: in main chunk`)).toEqual(true)
    }
})

test('should get only the last result on run', async () => {
    const engine = await getEngine()

    const a = await engine.doString(`return 1`)
    const b = await engine.doString(`return 3`)
    const c = engine.doStringSync(`return 2`)
    const d = engine.doStringSync(`return 5`)

    expect(a).toEqual(1)
    expect(b).toEqual(3)
    expect(c).toEqual(2)
    expect(d).toEqual(5)
})

test('should get only the return values on call function', async () => {
    const engine = await getEngine()
    engine.global.set('hello', (name) => `Hello ${name}!`)

    const a = await engine.doString(`return 1`)
    const b = engine.doStringSync(`return 5`)
    const values = engine.global.call('hello', 'joao')

    expect(a).toEqual(1)
    expect(b).toEqual(5)
    expect(values).toHaveLength(1)
    expect(values[0]).toEqual('Hello joao!')
})
