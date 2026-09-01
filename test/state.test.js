import { EventEmitter } from 'events'
import { LuaReturn, LuaThread, LuaType, decorate } from '../dist/index.js'
import { expect } from 'chai'
import { getState, getLua } from './utils.js'
import { setTimeout } from 'node:timers/promises'
import { mock } from 'node:test'

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

describe('State', () => {
    let intervals = []
    const setIntervalSafe = (callback, interval) => {
        const handle = setInterval(() => callback(), interval)
        intervals.push(handle)
        return () => clearInterval(handle)
    }

    afterEach(() => {
        for (const interval of intervals) {
            clearInterval(interval)
        }
        intervals = []
    })

    it('receive lua table on JS function should succeed', async () => {
        using state = await getState()
        state.set('stringify', (table) => {
            return JSON.stringify(table)
        })

        await state.doString('value = stringify({ test = 1 })')

        expect(state.get('value')).to.be.equal(JSON.stringify({ test: 1 }))
    })

    it('get a global table inside a JS function called by lua should succeed', async () => {
        using state = await getState()
        state.set('t', { test: 1 })
        state.set('test', () => {
            return state.get('t')
        })

        const value = await state.doString('return test(2)')

        expect(value).to.be.eql({ test: 1 })
    })

    it('receive JS object on lua should succeed', async () => {
        using state = await getState()

        state.set('test', () => {
            return {
                aaaa: 1,
                bbb: 'hey',
                test() {
                    return 22
                },
            }
        })
        const value = await state.doString('return test().test()')

        expect(value).to.be.equal(22)
    })

    it('receive JS object with circular references on lua should succeed', async () => {
        using state = await getState()
        const obj = {
            hello: 'world',
        }
        obj.self = obj
        state.set('obj', obj)

        const value = await state.doString('return obj.self.self.self.hello')

        expect(value).to.be.equal('world')
    })

    it('receive Lua object with circular references on JS should succeed', async () => {
        using state = await getState()
        const value = await state.doString(`
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
        using state = await getState()
        const value = await state.doString(`
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

    it('only a lua sequence becomes a JS array', async () => {
        using state = await getState()
        const value = await state.doString(`
            return {
                sequence = { 10, 20, 30 },
                float_keys = { [1.0] = 'a', [2.0] = 'b' },
                hole = { [2] = 'b' },
                string_keys = { ['1'] = 'a', ['2'] = 'b' },
                mixed = { 'a', 'b', name = 'c' },
                empty = {},
            }
        `)

        expect(value).to.be.eql({
            sequence: [10, 20, 30],
            float_keys: ['a', 'b'],
            hole: { 2: 'b' },
            string_keys: { 1: 'a', 2: 'b' },
            mixed: { 1: 'a', 2: 'b', name: 'c' },
            empty: {},
        })
        expect(Array.isArray(value.string_keys)).to.be.false
        expect(Array.isArray(value.empty)).to.be.false
    })

    it('receive JS object with multiple circular references on lua should succeed', async () => {
        using state = await getState()
        const obj1 = {
            hello: 'world',
        }
        obj1.self = obj1
        const obj2 = {
            hello: 'everybody',
        }
        obj2.self = obj2
        state.set('obj', { obj1, obj2 })

        await state.doString(`
            assert(obj.obj1.self.self.hello == "world")
            assert(obj.obj2.self.self.hello == "everybody")
        `)
    })

    it('receive JS object with null prototype on lua should succeed', async () => {
        using state = await getState()
        const obj = Object.create(null)
        obj.hello = 'world'
        state.set('obj', obj)

        const value = await state.doString(`return obj.hello`)

        expect(value).to.be.equal('world')
    })

    it('inherited properties should not be copied into the lua table', async () => {
        using state = await getState({ objects: 'copy' })
        const obj = Object.create({ inherited: 'yes' })
        obj.own = 'mine'
        state.set('t', obj)

        const keys = await state.doString(`
            local out = {}
            for key in pairs(t) do out[#out + 1] = key end
            table.sort(out)
            return table.concat(out, ',')
        `)

        expect(keys).to.be.equal('own')
    })

    it('non enumerable properties should not be copied into the lua table', async () => {
        using state = await getState({ objects: 'copy' })
        const obj = { own: 'mine' }
        Object.defineProperty(obj, 'hidden', { value: 1, enumerable: false })
        state.set('t', obj)

        expect(await state.doString('return t.hidden == nil')).to.be.true
        expect(await state.doString('return t.own')).to.be.equal('mine')
    })

    it('nested arrays and objects should be copied into the lua table', async () => {
        using state = await getState({ objects: 'copy' })
        state.set('t', { list: [10, 20, 30], nested: { deep: [{ value: 5 }] } })

        expect(await state.doString('return #t.list')).to.be.equal(3)
        expect(await state.doString('return t.list[1]')).to.be.equal(10)
        expect(await state.doString('return t.nested.deep[1].value')).to.be.equal(5)
    })

    it('a lua syntax error should throw on JS', async () => {
        using state = await getState()

        await expect(state.doString(`x -`)).to.eventually.be.rejectedWith(/syntax error near/)
    })

    it('call a lua function from JS should succeed', async () => {
        using state = await getState()

        await state.doString(`function sum(x, y) return x + y end`)
        const sum = state.get('sum')

        expect(sum(10, 50)).to.be.equal(60)
    })

    it('scheduled lua calls should succeed', async () => {
        using state = await getState()
        state.set('setInterval', setIntervalSafe)

        await state.doString(`
            test = ""
            done = false
            local stop
            stop = setInterval(function()
                test = test .. "i"
                if #test >= 5 then
                    stop()
                    done = true
                end
            end, 1)
        `)

        const deadline = Date.now() + 1000
        while (!state.get('done')) {
            if (Date.now() > deadline) {
                throw new Error('timed out waiting for scheduled lua calls')
            }
            await setTimeout(5)
        }

        expect(state.get('test')).to.be.equal('iiiii')
    })

    it('calling a lua function after close should throw', async () => {
        using state = await getState()

        const callback = await state.doString(`
            test = 0
            return function()
                test = test + 1
            end
        `)
        state.close()

        expect(() => callback()).to.throw('cannot call a Lua function after its state has been closed')
    })

    it('call lua function from JS passing an array argument should succeed', async () => {
        using state = await getState()

        const sum = await state.doString(`
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
        using state = await getState()

        await state.doString(`
            function f(x,y)
                return 1,x,y,"Hello World",{},function() end
            end
        `)

        const returns = state.call('f', 10, 25)
        expect(returns).to.have.length(6)
        expect(returns.slice(0, -1)).to.eql([1, 10, 25, 'Hello World', {}])
        expect(returns.at(-1)).to.be.a('function')
    })

    it('get a lua thread should succeed', async () => {
        using state = await getState()

        const thread = await state.doString(`
            return coroutine.create(function()
                print("hey")
            end)
        `)

        expect(thread).to.be.instanceOf(LuaThread)
        expect(thread).to.not.be.equal(0)
    })

    it('a JS error should pause lua execution', async () => {
        using state = await getState()
        const check = mock.fn()
        state.set('check', check)
        state.set('throw', () => {
            throw new Error('expected error')
        })

        await expect(
            state.doString(`
                throw()
                check()
            `),
        ).eventually.to.be.rejected
        expect(check.mock.calls).to.have.length(0)
    })

    it('catch a JS error with pcall should succeed', async () => {
        using state = await getState()
        const check = mock.fn()
        state.set('check', check)
        state.set('throw', () => {
            throw new Error('expected error')
        })

        await state.doString(`
            local success, err = pcall(throw)
            assert(success == false)
            assert(tostring(err) == "Error: expected error")
            check()
        `)

        expect(check.mock.calls).to.have.length(1)
    })

    it('call a JS function in a different thread should succeed', async () => {
        using state = await getState()
        const sum = mock.fn((x, y) => x + y)
        state.set('sum', sum)

        await state.doString(`
            coroutine.resume(coroutine.create(function()
                sum(10, 20)
            end))
        `)

        expect(sum.mock.calls).to.have.length(1)
        expect(sum.mock.calls[0].arguments).to.be.eql([10, 20])
    })

    it('get callable table as function should succeed', async () => {
        using state = await getState()
        await state.doString(`
        _G['sum'] = setmetatable({}, {
            __call = function(self, x, y)
                return x + y
            end
        })
    `)

        state.module.lua_getglobal(state.address, 'sum')
        const sum = state.getValue(-1, LuaType.Function)

        expect(sum(10, 30)).to.be.equal(40)
    })

    it('lua_resume with yield succeeds', async () => {
        using state = await getState()
        const thread = state.newThread()
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
        using state = await getState({ memory: { trace: true } })
        expect(state.memory.used).to.be.greaterThan(0)
    })

    it('get memory should return correct', async () => {
        using state = await getState({ memory: { trace: true } })

        const totalMemory = await state.doString(`
        collectgarbage()
        local x = 10
        local batata = { dawdwa = 1 }
        return collectgarbage('count') * 1024
    `)

        expect(state.memory.used).to.be.equal(totalMemory)
    })

    it('memory is undefined without tracing', async () => {
        using state = await getState()

        expect(state.memory).to.be.undefined
    })

    it('limit memory use causes program loading failure succeeds', async () => {
        using state = await getState({ memory: { trace: true } })
        state.memory.max = state.memory.used
        expect(() => {
            state.loadString(`
            local a = 10
            local b = 20
            return a + b
        `)
        }).to.throw('not enough memory')

        // Remove the limit and retry
        state.memory.max = undefined
        state.loadString(`
        local a = 10
        local b = 20
        return a + b
    `)
    })

    it('limit memory use causes program runtime failure succeeds', async () => {
        using state = await getState({ memory: { trace: true } })
        state.loadString(`
        local tab = {}
        for i = 1, 50, 1 do
            tab[i] = i
        end
    `)
        state.memory.max = state.memory.used

        await expect(state.run()).to.eventually.be.rejectedWith('not enough memory')
    })

    it('table supported circular dependencies', async () => {
        using state = await getState()

        const a = { name: 'a' }
        const b = { name: 'b' }
        b.a = a
        a.b = b

        state.pushValue(a)
        const res = state.getValue(-1)

        expect(res.b.a).to.be.eql(res)
    })

    it('wrap a js object (with metatable)', async () => {
        using state = await getState()
        state.set('TestClass', {
            create: (name) => {
                return decorate(
                    {
                        instance: decorate(new TestClass(name), { as: 'userdata' }),
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

        const res = await state.doString(`
        local instance = TestClass.create("demo name")
        return instance.name
    `)
        expect(res).to.be.equal('demo name')
    })

    it('wrap a js object using proxy', async () => {
        using state = await getState()
        state.set('TestClass', {
            create: (name) => new TestClass(name),
        })
        const res = await state.doString(`
        local instance = TestClass.create("demo name 2")
        return instance:getName()
    `)
        expect(res).to.be.equal('demo name 2')
    })

    it('wrap a js object using proxy and apply metatable in lua', async () => {
        using state = await getState()
        state.set('TestClass', {
            create: (name) => new TestClass(name),
        })
        const res = await state.doString(`
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
        using state = await getState()
        state.set('obj', { TestClass })

        const testClass = await state.doString(`
        return obj.TestClass
    `)

        expect(testClass).to.be.equal(TestClass)
    })

    it('timeout blocking lua program', async () => {
        using state = await getState()
        state.loadString(`
            local i = 0
            while true do i = i + 1 end
        `)

        await expect(state.run(0, { timeout: 5 })).eventually.to.be.rejectedWith('thread timeout exceeded')
    })

    it('the most recently set timeout should be the one that applies', async function () {
        this.timeout(30_000)
        using state = await getState()
        const thread = state.newThread()

        thread.setDeadline(Date.now() + 20)
        thread.setDeadline(Date.now() + 20_000)
        thread.loadString('local x = 0 for i = 1, 20000000 do x = x + 1 end return x')

        expect((await thread.run(0))[0]).to.be.equal(20000000)
    })

    it('clearing a timeout should disable the hook', async function () {
        this.timeout(30_000)
        using state = await getState()
        const thread = state.newThread()

        thread.setDeadline(Date.now() + 10)
        thread.setDeadline(undefined)
        thread.loadString('local x = 0 for i = 1, 5000000 do x = x + 1 end return 7')

        expect(thread.getDeadline()).to.be.undefined
        expect((await thread.run(0))[0]).to.be.equal(7)
    })

    it('overwrite lib function', async () => {
        using state = await getState()

        let output = ''
        state.getTable('_G', (index) => {
            state.setField(index, 'print', (val) => {
                // Not a proper print implementation.
                output += `${val}\n`
            })
        })

        await state.doString(`
        print("hello")
        print("world")
    `)

        expect(output).to.be.equal('hello\nworld\n')
    })

    it('inject a userdata with a metatable should succeed', async () => {
        using state = await getState()
        const obj = decorate(
            {},
            {
                metatable: { __index: (_, k) => `Hello ${k}!` },
            },
        )
        state.set('obj', obj)

        const res = await state.doString('return obj.World')

        expect(res).to.be.equal('Hello World!')
    })

    it('a userdata should be collected', async () => {
        using state = await getState()
        const obj = {}
        state.set('obj', obj)
        const refIndex = state.module.getLastRefIndex()
        const oldRef = state.module.getRef(refIndex)

        await state.doString(`
        local weaktable = {}
        setmetatable(weaktable, { __mode = "v" })
        table.insert(weaktable, obj)
        obj = nil
        collectgarbage()
        assert(next(weaktable) == nil)
    `)

        expect(oldRef).to.be.equal(obj)
        const newRef = state.module.getRef(refIndex)
        expect(newRef).to.be.equal(undefined)
    })

    it('environment variables should be set', async () => {
        const lua = await getLua({ env: { TEST: 'true' } })
        const state = lua.createState()

        const testEnvVar = await state.doString(`return os.getenv('TEST')`)

        expect(testEnvVar).to.be.equal('true')
    })

    it('static methods should be callable on classes', async () => {
        using state = await getState()
        state.set('TestClass', TestClass)

        const testHello = await state.doString(`return TestClass.hello()`)

        expect(testHello).to.be.equal('world')
    })

    it('should be possible to access function properties', async () => {
        using state = await getState()
        const testFunction = () => undefined
        testFunction.hello = 'world'
        state.set('TestFunction', decorate(testFunction, { as: 'proxy' }))

        const testHello = await state.doString(`return TestFunction.hello`)

        expect(testHello).to.be.equal('world')
    })

    it('throw error includes stack trace', async () => {
        using state = await getState()
        try {
            await state.doString(`
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
            expect(err.message).to.not.includes('stack traceback:')
            expect(err.luaMessage).to.be.equal(err.message)
            expect(err.traceback).to.includes('stack traceback:')
            expect(err.traceback).to.includes(`[string "..."]:3: in upvalue 'a'`)
            expect(err.traceback).to.includes(`[string "..."]:5: in upvalue 'b'`)
            expect(err.traceback).to.includes(`[string "..."]:6: in local 'c'`)
            expect(err.traceback).to.includes(`[string "..."]:7: in main chunk`)
            // Still reachable through the default logging path.
            expect(err.stack).to.includes('stack traceback:')
        }
    })

    it('should get only the last result on run', async () => {
        using state = await getState()

        const a = await state.doString(`return 1`)
        const b = await state.doString(`return 3`)
        const c = state.doStringSync(`return 2`)
        const d = state.doStringSync(`return 5`)

        expect(a).to.be.equal(1)
        expect(b).to.be.equal(3)
        expect(c).to.be.equal(2)
        expect(d).to.be.equal(5)
    })

    it('should get only the return values on call function', async () => {
        using state = await getState()
        state.set('hello', (name) => `Hello ${name}!`)

        const a = await state.doString(`return 1`)
        const b = state.doStringSync(`return 5`)
        const values = state.call('hello', 'joao')

        expect(a).to.be.equal(1)
        expect(b).to.be.equal(5)
        expect(values).to.have.length(1)
        expect(values[0]).to.be.equal('Hello joao!')
    })

    it('create a large string variable should succeed', async () => {
        using state = await getState()
        const str = 'a'.repeat(1000000)

        state.set('str', str)

        const res = await state.doString('return str')

        expect(res).to.be.equal(str)
    })

    it('execute a large string should succeed', async () => {
        using state = await getState()
        const str = 'a'.repeat(1000000)

        const res = await state.doString(`return [[${str}]]`)

        expect(res).to.be.equal(str)
    })

    it('a large multibyte string should keep its byte length', async function () {
        this.timeout(30_000)
        using state = await getState()
        const str = 'á'.repeat(500000)

        state.set('str', str)

        expect(await state.doString('return #str')).to.be.equal(1000000)
        expect(await state.doString('return str')).to.be.equal(str)
    })

    it('a string containing NUL should be pushed with its full length', async () => {
        using state = await getState()
        state.set('str', 'a\0b')

        expect(await state.doString('return #str')).to.be.equal(3)
    })

    it('a string containing NUL should be retrieved with its full length', async () => {
        using state = await getState()

        const res = await state.doString('return "x\\0y"')

        expect(res).to.be.equal('x\0y')
    })

    it('a string containing NUL should round trip unchanged', async () => {
        using state = await getState()
        const str = 'before\0middle\0after'
        state.set('str', str)

        expect(await state.doString('return str')).to.be.equal(str)
    })

    it('an empty string should round trip unchanged', async () => {
        using state = await getState()
        state.set('str', '')

        expect(await state.doString('return #str')).to.be.equal(0)
        expect(await state.doString('return str')).to.be.equal('')
    })

    it('getStringBytes should expose bytes that are not valid UTF-8', async () => {
        using state = await getState()
        await state.doString('value = string.char(0, 255, 128, 65)')

        state.module.lua_getglobal(state.address, 'value')
        const bytes = state.getStringBytes(-1)
        state.pop()

        expect(Array.from(bytes)).to.be.eql([0, 255, 128, 65])
    })

    it('getStringBytes should return undefined for a non string value', async () => {
        using state = await getState()
        state.pushValue({})

        expect(state.getStringBytes(-1)).to.be.undefined

        state.pop()
    })

    it('bytecode should round trip through the byte accessors', async () => {
        using state = await getState()
        await state.doString('bytecode = string.dump(load("return 42"))')

        state.module.lua_getglobal(state.address, 'bytecode')
        const bytes = state.getStringBytes(-1)
        state.pop()

        state.pushStringBytes(bytes)
        state.module.lua_setglobal(state.address, 'roundtripped')

        expect(await state.doString('return load(roundtripped)()')).to.be.equal(42)
    })

    it('negative integers should be pushed and retrieved as string', async () => {
        using state = await getState()
        state.set('value', -1)

        const res = await state.doString(`return tostring(value)`)

        expect(res).to.be.equal('-1')
    })

    it('negative integers should be pushed and retrieved as number', async () => {
        using state = await getState()
        state.set('value', -1)

        const res = await state.doString(`return value`)

        expect(res).to.be.equal(-1)
    })

    it('number greater than 32 bit int should be pushed and retrieved as string', async () => {
        using state = await getState()
        const value = 1689031554550
        state.set('value', value)

        const res = await state.doString(`return tostring(value)`)

        expect(res).to.be.equal(`${String(value)}`)
    })

    it('number greater than 32 bit int should be pushed and retrieved as number', async () => {
        using state = await getState()
        const value = 1689031554550
        state.set('value', value)

        const res = await state.doString(`return value`)

        expect(res).to.be.equal(value)
    })

    it('number greater than 32 bit int should be usable as a format argument', async () => {
        using state = await getState()
        const value = 1689031554550
        state.set('value', value)

        const res = await state.doString(`return ("%d"):format(value)`)

        expect(res).to.be.equal('1689031554550')
    })

    it('64-bit integers pushed through the raw Lua API should keep integer semantics', async () => {
        using state = await getState()
        const value = 9223372036854775807n

        state.module.lua_pushinteger(state.address, value)
        state.module.lua_setglobal(state.address, 'value')

        const asString = await state.doString(`return tostring(value)`)
        const asFormatted = await state.doString(`return ("%d"):format(value)`)

        state.module.lua_getglobal(state.address, 'value')
        const roundTrip = state.module.lua_tointegerx(state.address, -1, null)
        state.pop()

        expect(asString).to.be.equal('9223372036854775807')
        expect(asFormatted).to.be.equal('9223372036854775807')
        expect(roundTrip).to.be.equal(value)
    })

    it('integers outside the JS safe range should be retrieved as bigint', async () => {
        using state = await getState()

        expect(await state.doString('return math.maxinteger')).to.be.equal(9223372036854775807n)
        expect(await state.doString('return math.mininteger')).to.be.equal(-9223372036854775808n)
    })

    it('integers inside the JS safe range should be retrieved as number', async () => {
        using state = await getState()

        const res = await state.doString('return 1689031554550')

        expect(res).to.be.equal(1689031554550)
        expect(res).to.be.a('number')
    })

    it('an integral number should be pushed as a lua integer', async () => {
        using state = await getState()
        state.set('value', 2)

        expect(await state.doString('return math.type(value)')).to.be.equal('integer')
    })

    it('floats should be retrieved as number', async () => {
        using state = await getState()

        expect(await state.doString('return 1.5')).to.be.equal(1.5)
        expect(await state.doString('return math.type(1.5)')).to.be.equal('float')
    })

    it('a bigint should be pushed as a 64 bit lua integer', async () => {
        using state = await getState()
        state.set('value', 9223372036854775807n)

        expect(await state.doString('return tostring(value)')).to.be.equal('9223372036854775807')
        expect(await state.doString('return math.type(value)')).to.be.equal('integer')
        expect(await state.doString('return value')).to.be.equal(9223372036854775807n)
    })

    it('a bigint outside the lua integer range should throw', async () => {
        using state = await getState()

        expect(() => state.set('value', 2n ** 70n)).to.throw(RangeError)
    })

    it('an integral number too large for a lua integer should be pushed as a float', async () => {
        using state = await getState()
        state.set('value', 1e300)

        expect(await state.doString('return math.type(value)')).to.be.equal('float')
        expect(await state.doString('return value')).to.be.equal(1e300)
    })

    it('yielding in a JS callback into Lua does not break lua state', async () => {
        // When yielding within a callback the error 'attempt to yield across a C-call boundary'.
        // This test just checks that throwing that error still allows the lua global to be
        // re-used and doesn't cause JS to abort or some nonsense.
        using state = await getState()
        const testEmitter = new EventEmitter()
        state.set('yield', () => new Promise((resolve) => testEmitter.once('resolve', resolve)))
        const resPromise = state.doString(`
        local res = yield():next(function ()
            coroutine.yield()
            return 15
        end)
        print("res", res:await())
      `)

        testEmitter.emit('resolve')
        await expect(resPromise).to.eventually.be.rejectedWith('Error: attempt to yield across a C-call boundary')

        expect(await state.doString(`return 42`)).to.equal(42)
    })

    it('forced yield within JS callback from Lua doesnt cause vm to crash', async () => {
        using state = await getState({ limits: { functionTimeout: 10 } })
        state.set('promise', Promise.resolve())
        const thread = state.newThread()
        thread.loadString(`
        promise:next(function ()
            while true do
              -- nothing
            end
        end):await()
      `)
        await expect(thread.run(0, { timeout: 5 })).to.eventually.be.rejectedWith('thread timeout exceeded')

        expect(await state.doString(`return 42`)).to.equal(42)
    })

    it('function callback timeout still allows timeout of caller thread', async () => {
        using state = await getState()
        state.set('promise', Promise.resolve())
        const thread = state.newThread()
        thread.loadString(`
        promise:next(function ()
            -- nothing
        end):await()
        while true do end
      `)
        await expect(thread.run(0, { timeout: 5 })).to.eventually.be.rejectedWith('thread timeout exceeded')
    })

    it('null injected and valid', async () => {
        using state = await getState()
        state.loadString(`
        local args = { ... }
        assert(args[1] == null, string.format("expected first argument to be null, got %s", tostring(args[1])))
        return null, args[1], tostring(null)
      `)
        state.pushValue(null)
        const res = await state.run(1)
        expect(res).to.deep.equal([null, null, 'null'])
    })

    it('null injected as nil', async () => {
        using state = await getState({ inject: false })
        state.loadString(`
        local args = { ... }
        assert(type(args[1]) == "nil", string.format("expected first argument to be nil, got %s", type(args[1])))
        return nil, args[1], tostring(nil)
      `)
        state.pushValue(null)
        const res = await state.run(1)
        expect(res).to.deep.equal([null, null, 'nil'])
    })

    it('reassigning the null global should not affect pushing null', async () => {
        using state = await getState()
        await state.doString('null = 5')

        state.set('value', null)

        expect(await state.doString('return type(value)')).to.be.equal('userdata')
        expect(state.get('value')).to.be.null
    })

    it('a pushed null should equal the injected null global', async () => {
        using state = await getState()
        state.set('value', null)

        expect(await state.doString('return value == null')).to.be.true
    })

    it('Nested callback from JS to Lua', async () => {
        using state = await getState()
        state.set('call', (fn) => fn())
        const res = await state.doString(`
        return call(function ()
          return call(function ()
            return 10
          end)
        end)
      `)
        expect(res).to.equal(10)
    })

    it('lots of doString calls should succeed', async () => {
        using state = await getState()
        const length = 10000

        for (let i = 0; i < length; i++) {
            const a = Math.floor(Math.random() * 100)
            const b = Math.floor(Math.random() * 100)
            const result = await state.doString(`return ${a} + ${b};`)
            expect(result).to.equal(a + b)
        }
    })

    it('lots of doStringSync calls should not grow the lua stack', async function () {
        this.timeout(30_000)
        using state = await getState()
        const startTop = state.getTop()

        for (let i = 0; i < 500; i++) {
            expect(state.doStringSync(`return ${i}`)).to.be.equal(i)
        }

        expect(state.getTop()).to.be.equal(startTop)
    })

    it('a failing doStringSync should not grow the lua stack', async () => {
        using state = await getState()
        const startTop = state.getTop()

        expect(() => state.doStringSync('error("boom")')).to.throw('boom')

        expect(state.getTop()).to.be.equal(startTop)
    })

    it('values returned by doStringSync should outlive the stack reset', async () => {
        using state = await getState()

        const fn = state.doStringSync('return function() return 3 end')
        const table = state.doStringSync('return { a = 1, b = { 2, 3 } }')

        expect(fn()).to.be.equal(3)
        expect(table).to.be.eql({ a: 1, b: [2, 3] })
    })

    it('many concurrent doString calls should succeed', async function () {
        this.timeout(15000)
        using state = await getState()
        const length = 55

        const promises = []
        for (let i = 0; i < length; i++) {
            promises.push(state.doString(`return ${i}`))
        }
        const results = await Promise.all(promises)

        for (let i = 0; i < length; i++) {
            expect(results[i]).to.equal(i)
        }
    })
})

describe('Load mode', () => {
    it('loadString refuses bytecode by default', async () => {
        using state = await getState()
        // Produced and reloaded inside Lua so the bytes never round trip through a JS string.
        expect(
            state.doStringSync(`
            local d = string.dump(function() return 42 end)
            local f, err = load(d, 'c', 't')
            return err
        `),
        ).to.include('attempt to load a binary chunk')
    })

    it('the host loader refuses a binary chunk by default', async () => {
        using state = await getState()

        expect(() => state.loadString('\x1bLua\x55\x00')).to.throw('attempt to load a binary chunk')
    })

    it('mode bt opts back in', async () => {
        using state = await getState()

        expect(
            state.doStringSync(`
            local d = string.dump(function() return 42 end)
            return load(d, 'c', 'bt')()
        `),
        ).to.be.equal(42)
    })
})

describe('Decoration', () => {
    class Thing {
        constructor(name) {
            this.name = name
        }
        getName() {
            return this.name
        }
    }

    it('as userdata hides the members', async () => {
        using state = await getState()
        state.set('thing', decorate(new Thing('bob'), { as: 'userdata' }))

        // An opaque userdata has no __index of its own, so Lua refuses to index it at all.
        await expect(state.doString('return thing.name')).to.eventually.be.rejectedWith('attempt to index a js_userdata value')
    })

    it('as userdata still cannot take a metatable of its own', async () => {
        using state = await getState()

        // The userdata extension owns the metatable slot. That is a constraint of the extension,
        // not of the decoration API, so a custom metatable has to go on a wrapper.
        expect(() => state.set('thing', decorate(new Thing('bob'), { as: 'userdata', metatable: { __name: 'js_thing' } }))).to.throw(
            'data already has associated metatable: js_userdata',
        )
    })

    it('a wrapper carries the metatable around an opaque userdata', async () => {
        using state = await getState()
        state.set(
            'thing',
            decorate(
                { inner: decorate(new Thing('bob'), { as: 'userdata' }) },
                { metatable: { __name: 'js_thing', __index: (self, key) => (key === 'name' ? self.inner.getName() : null) } },
            ),
        )

        expect(await state.doString('return thing.name')).to.be.equal('bob')
    })

    it('as value copies an object instead of proxying it', async () => {
        using state = await getState()
        state.set('plain', decorate({ a: 1 }, { as: 'value' }))

        expect(await state.doString('return type(plain)')).to.be.equal('table')
    })

    it('as proxy forces a function through the proxy layer', async () => {
        using state = await getState()
        const fn = () => undefined
        fn.hello = 'world'
        state.set('fn', decorate(fn, { as: 'proxy' }))

        expect(await state.doString('return fn.hello')).to.be.equal('world')
    })
})

describe('Memory', () => {
    it('memory.max turns tracing on by itself', async () => {
        const lua = await getLua()
        using state = lua.createState({ memory: { max: 4 * 1024 * 1024 } })

        expect(state.memory).to.not.be.undefined
        expect(state.memory.max).to.be.equal(4 * 1024 * 1024)
        expect(state.memory.used).to.be.greaterThan(0)
    })

    it('a max too small to hold a state is reported as such', async () => {
        const lua = await getLua()

        expect(() => lua.createState({ memory: { max: 1000 } })).to.throw('memory.max of 1000 bytes')
    })

    it('memory is a live view', async () => {
        using state = await getState({ memory: { trace: true } })

        const before = state.memory.used
        await state.doString('big = {} for i = 1, 5000 do big[i] = i end')

        expect(state.memory.used).to.be.greaterThan(before)
    })
})

describe('Synchronous runs', () => {
    it('do not leak stack onto the state between calls', async () => {
        using state = await getState()
        const top = state.getTop()

        for (let i = 0; i < 50; i++) {
            state.doStringSync('return 1')
        }

        expect(state.getTop()).to.be.equal(top)
    })

    it('a hook installed for a sync run does not outlive it', async () => {
        using state = await getState()

        state.doStringSync('return 1', { timeout: 1000 })

        expect(state.getDeadline()).to.be.undefined
    })
})
