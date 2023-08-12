const { LuaLibraries, LuaReturn, LuaThread, LuaType, decorate, decorateProxy, decorateUserdata } = require('..')
const { expect } = require('chai')
const { getEngine, getFactory } = require('./utils')
const { setTimeout } = require('node:timers/promises')
const jestMock = require('jest-mock')

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

describe('Engine', () => {
    it('receive lua table on JS function should succeed', async () => {
        const engine = await getEngine()
        engine.global.set('stringify', (table) => {
            return JSON.stringify(table)
        })

        await engine.doString('value = stringify({ test = 1 })')

        expect(engine.global.get('value')).to.be.equal(JSON.stringify({ test: 1 }))
    })

    it('get a global table inside a JS function called by lua should succeed', async () => {
        const engine = await getEngine()
        engine.global.set('t', { test: 1 })
        engine.global.set('test', () => {
            return engine.global.get('t')
        })

        const value = await engine.doString('return test(2)')

        expect(value).to.be.eql({ test: 1 })
    })

    it('receive JS object on lua should succeed', async () => {
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

        expect(value).to.be.equal(22)
    })

    it('receive JS object with circular references on lua should succeed', async () => {
        const engine = await getEngine()
        const obj = {
            hello: 'world',
        }
        obj.self = obj
        engine.global.set('obj', obj)

        const value = await engine.doString('return obj.self.self.self.hello')

        expect(value).to.be.equal('world')
    })

    it('receive Lua object with circular references on JS should succeed', async () => {
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

        const obj = {
            obj1: {
                hello: 'world',
            },
            1: {
                1: 5,
                hello: 'everybody',
                array: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
                // Emulate the lua function
                fn: value[1].fn,
            },
        }
        obj.obj1.self = obj.obj1
        obj[1].self = obj[1]
        expect(value).to.deep.eql(obj)
    })

    it('receive lua array with circular references on JS should succeed', async () => {
        const engine = await getEngine()
        const value = await engine.doString(`
            obj = {
                "hello",
                "world"
            }
            table.insert(obj, obj)
            return obj
        `)

        const arr = ['hello', 'world']
        arr.push(arr)
        expect(value).to.be.eql(arr)
    })

    it('receive JS object with multiple circular references on lua should succeed', async () => {
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

    it('receive JS object with null prototype on lua should succeed', async () => {
        const engine = await getEngine()
        const obj = Object.create(null)
        obj.hello = 'world'
        engine.global.set('obj', obj)

        const value = await engine.doString(`return obj.hello`)

        expect(value).to.be.equal('world')
    })

    it('a lua error should throw on JS', async () => {
        const engine = await getEngine()

        await expect(engine.doString(`x -`)).to.eventually.be.rejected
    })

    it('call a lua function from JS should succeed', async () => {
        const engine = await getEngine()

        await engine.doString(`function sum(x, y) return x + y end`)
        const sum = engine.global.get('sum')

        expect(sum(10, 50)).to.be.equal(60)
    })

    // TEST OFTEN BREAKS
    it('scheduled lua calls should succeed', async () => {
        const engine = await getEngine()
        engine.global.set('setInterval', setInterval)

        await engine.doString(`
            test = ""
            setInterval(function ()
                test = test .. "i"
            end, 1)
        `)
        await setTimeout(20)

        const test = engine.global.get('test')
        expect(test).length.above(3)
        expect(test).length.below(21)
        expect(test).to.be.equal(''.padEnd(test.length, 'i'))
    })

    it('scheduled lua calls should fail silently if invalid', async () => {
        const engine = await getEngine()
        engine.global.set('setInterval', setInterval)

        // TODO: Disable mock at the end of the test.
        jestMock.spyOn(console, 'warn').mockImplementation(() => {
            // Nothing to do.
        })

        await engine.doString(`
            test = 0
            setInterval(function()
                test = test + 1
            end, 5)
        `)

        engine.global.close()

        await setTimeout(5 + 5)
    })

    it('call lua function from JS passing an array argument should succeed', async () => {
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

        expect(sum([10, 50, 25])).to.be.equal(85)
    })

    it('call a global function with multiple returns should succeed', async () => {
        const engine = await getEngine()

        await engine.doString(`
            function f(x,y)
                return 1,x,y,"Hello World",{},function() end
            end
        `)

        const returns = engine.global.call('f', 10, 25)
        expect(returns).to.have.length(6)
        expect(returns.slice(0, -1)).to.eql([1, 10, 25, 'Hello World', {}])
        expect(returns.at(-1)).to.be.a('function')
    })

    it('doString with multiple returns should succeed', async () => {
        const engine = await getEngine()

        const returns = await engine.doString(`
            return 1, x, y, "Hello World", {}, function() end, {1,2,3}, {a = 1, b = 2, c = 3};
        `)

        expect(returns).to.be.a('array')
        expect(returns).to.have.length(8)
        expect(returns[5]).to.be.a('function')
        expect(returns[6]).to.be.a('array')
        expect(returns[7]).to.be.a('object')
    })

    it('call lua function with multiple returns should succeed', async () => {
        const engine = await getEngine()

        const fn = await engine.doString(`
            return function (x, y)
                return 1, x, y, function () end, {1,2,3}, {a = 1, b = 2};
            end
        `)

        expect(fn).to.be.a('function')

        const returns = fn(4, 5)
        const [func, arr, obj] = returns.slice(3)
        expect(returns).to.have.length(6)
        expect(func).to.be.a('function')
        expect(arr).to.be.a('array')
        expect(obj).to.be.a('object')
    })

    it('call lua function with single returns array should succeed', async () => {
        const engine = await getEngine()

        const fn = await engine.doString(`
            return function (a, b, c)
                return {a, b, c};
            end
        `)

        expect(fn).to.be.a('function')
        const array = fn(3, 4, 5)
        expect(array).to.be.an('array')
        expect(array).to.have.length(3)
    })

    it('get a lua thread should succeed', async () => {
        const engine = await getEngine()

        const thread = await engine.doString(`
            return coroutine.create(function()
                print("hey")
            end)
        `)

        expect(thread).to.be.instanceOf(LuaThread)
        expect(thread).to.not.be.equal(0)
    })

    it('a JS error should pause lua execution', async () => {
        const engine = await getEngine()
        const check = jestMock.fn()
        engine.global.set('check', check)
        engine.global.set('throw', () => {
            throw new Error('expected error')
        })

        await expect(
            engine.doString(`
                throw()
                check()
            `),
        ).eventually.to.be.rejected
        expect(check.mock.calls).to.have.length(0)
    })

    it('catch a JS error with pcall should succeed', async () => {
        const engine = await getEngine()
        const check = jestMock.fn()
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

        expect(check.mock.calls).to.have.length(1)
    })

    it('call a JS function in a different thread should succeed', async () => {
        const engine = await getEngine()
        const sum = jestMock.fn((x, y) => x + y)
        engine.global.set('sum', sum)

        await engine.doString(`
            coroutine.resume(coroutine.create(function()
                sum(10, 20)
            end))
        `)

        expect(sum.mock.lastCall).to.be.eql([10, 20])
    })

    it('get callable table as function should succeed', async () => {
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

        expect(sum(10, 30)).to.be.equal(40)
    })

    it('lua_resume with yield succeeds', async () => {
        const engine = await getEngine()
        const thread = engine.global.newThread()
        thread.loadString(`
        local yieldRes = coroutine.yield(10)
        return yieldRes
    `)

        const resumeResult = thread.resume(0)
        expect(resumeResult.result).to.be.equal(LuaReturn.Yield)
        expect(resumeResult.resultCount).to.be.equal(1)

        const yieldValue = thread.getValue(-1)
        expect(yieldValue).to.be.equal(10)

        thread.pop(resumeResult.resultCount)
        thread.pushValue(yieldValue * 2)

        const finalResumeResult = thread.resume(1)
        expect(finalResumeResult.result).to.be.equal(LuaReturn.Ok)
        expect(finalResumeResult.resultCount).to.be.equal(1)

        const finalValue = thread.getValue(-1)
        expect(finalValue).to.be.equal(20)
    })

    it('get memory with allocation tracing should succeeds', async () => {
        const engine = await getEngine({ traceAllocations: true })
        expect(engine.global.getMemoryUsed()).to.be.greaterThan(0)
    })

    it('get memory should return correct', async () => {
        const engine = await getEngine({ traceAllocations: true })

        const totalMemory = await engine.doString(`
        collectgarbage()
        local x = 10
        local batata = { dawdwa = 1 }
        return collectgarbage('count') * 1024
    `)

        expect(engine.global.getMemoryUsed()).to.be.equal(totalMemory)
    })

    it('get memory without tracing should throw', async () => {
        const engine = await getEngine({ traceAllocations: false })

        expect(() => engine.global.getMemoryUsed()).to.throw()
    })

    it('limit memory use causes program loading failure succeeds', async () => {
        const engine = await getEngine({ traceAllocations: true })
        engine.global.setMemoryMax(engine.global.getMemoryUsed())
        expect(() => {
            engine.global.loadString(`
            local a = 10
            local b = 20
            return a + b
        `)
        }).to.throw('not enough memory')

        // Remove the limit and retry
        engine.global.setMemoryMax(undefined)
        engine.global.loadString(`
        local a = 10
        local b = 20
        return a + b
    `)
    })

    it('limit memory use causes program runtime failure succeeds', async () => {
        const engine = await getEngine({ traceAllocations: true })
        engine.global.loadString(`
        local tab = {}
        for i = 1, 50, 1 do
            tab[i] = i
        end
    `)
        engine.global.setMemoryMax(engine.global.getMemoryUsed())

        await expect(engine.global.run()).to.eventually.be.rejectedWith('not enough memory')
    })

    it('table supported circular dependencies', async () => {
        const engine = await getEngine()

        const a = { name: 'a' }
        const b = { name: 'b' }
        b.a = a
        a.b = b

        engine.global.pushValue(a)
        const res = engine.global.getValue(-1)

        expect(res.b.a).to.be.eql(res)
    })

    it('wrap a js object (with metatable)', async () => {
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
        expect(res).to.be.equal('demo name')
    })

    it('wrap a js object using proxy', async () => {
        const engine = await getEngine()
        engine.global.set('TestClass', {
            create: (name) => new TestClass(name),
        })
        const res = await engine.doString(`
        local instance = TestClass.create("demo name 2")
        return instance:getName()
    `)
        expect(res).to.be.equal('demo name 2')
    })

    it('wrap a js object using proxy and apply metatable in lua', async () => {
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
        expect(res).to.be.equal('wrapped: demo')
    })

    it('classes should be a userdata when proxied', async () => {
        const engine = await getEngine()
        engine.global.set('obj', { TestClass })

        const testClass = await engine.doString(`
        return obj.TestClass
    `)

        expect(testClass).to.be.equal(TestClass)
    })

    it('timeout blocking lua program', async () => {
        const engine = await getEngine()
        const thread = engine.global.newThread()

        thread.loadString(`
        local i = 0
        while true do i = i + 1 end
    `)

        await expect(thread.run(0, { timeout: 5 })).eventually.to.be.rejectedWith('thread timeout exceeded')
    })

    it('overwrite lib function', async () => {
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

        expect(output).to.be.equal('hello\nworld\n')
    })

    it('inject a userdata with a metatable should succeed', async () => {
        const engine = await getEngine()
        const obj = decorate(
            {},
            {
                metatable: { __index: (_, k) => `Hello ${k}!` },
            },
        )
        engine.global.set('obj', obj)

        const res = await engine.doString('return obj.World')

        expect(res).to.be.equal('Hello World!')
    })

    it('a userdata should be collected', async () => {
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

        expect(oldRef).to.be.equal(obj)
        const newRef = engine.global.lua.getRef(refIndex)
        expect(newRef).to.be.equal(undefined)
    })

    it('environment variables should be set', async () => {
        const factory = getFactory({ TEST: 'true' })
        const engine = await factory.createEngine()

        const testEnvVar = await engine.doString(`return os.getenv('TEST')`)

        expect(testEnvVar).to.be.equal('true')
    })

    it('static methods should be callable on classes', async () => {
        const engine = await getEngine()
        engine.global.set('TestClass', TestClass)

        const testHello = await engine.doString(`return TestClass.hello()`)

        expect(testHello).to.be.equal('world')
    })

    it('should be possible to access function properties', async () => {
        const engine = await getEngine()
        const testFunction = () => undefined
        testFunction.hello = 'world'
        engine.global.set('TestFunction', decorateProxy(testFunction, { proxy: true }))

        const testHello = await engine.doString(`return TestFunction.hello`)

        expect(testHello).to.be.equal('world')
    })

    it('throw error includes stack trace', async () => {
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
            expect(err.message).to.includes('[string "..."]:3: function a threw error')
            expect(err.message).to.includes('stack traceback:')
            expect(err.message).to.includes(`[string "..."]:3: in upvalue 'a'`)
            expect(err.message).to.includes(`[string "..."]:5: in upvalue 'b'`)
            expect(err.message).to.includes(`[string "..."]:6: in local 'c'`)
            expect(err.message).to.includes(`[string "..."]:7: in main chunk`)
        }
    })

    it('should get only the last result on run', async () => {
        const engine = await getEngine()

        const a = await engine.doString(`return 1`)
        const b = await engine.doString(`return 3`)
        const c = engine.doStringSync(`return 2`)
        const d = engine.doStringSync(`return 5`)

        expect(a).to.be.equal(1)
        expect(b).to.be.equal(3)
        expect(c).to.be.equal(2)
        expect(d).to.be.equal(5)
    })

    it('should get only the return values on call function', async () => {
        const engine = await getEngine()
        engine.global.set('hello', (name) => `Hello ${name}!`)

        const a = await engine.doString(`return 1`)
        const b = engine.doStringSync(`return 5`)
        const values = engine.global.call('hello', 'joao')

        expect(a).to.be.equal(1)
        expect(b).to.be.equal(5)
        expect(values).to.have.length(1)
        expect(values[0]).to.be.equal('Hello joao!')
    })

    it('create a large string variable should succeed', async () => {
        const engine = await getEngine()
        const str = 'a'.repeat(1000000)

        engine.global.set('str', str)

        const res = await engine.doString('return str')

        expect(res).to.be.equal(str)
    })

    it('execute a large string should succeed', async () => {
        const engine = await getEngine()
        const str = 'a'.repeat(1000000)

        const res = await engine.doString(`return [[${str}]]`)

        expect(res).to.be.equal(str)
    })
})
