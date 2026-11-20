import { execFileSync } from 'node:child_process'
import { expect } from 'chai'
import { LuaRuntime, LuaTimeoutError, LuaAbortError, LuaInstructionLimitError, LuaMultiReturn } from '../dist/index.js'
import { getState } from './utils.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 1))

describe('Async runs', () => {
    it('a top level coroutine.yield hands its values to onYield and resumes with its return', async () => {
        using state = await getState()
        const thread = state.newThread()
        thread.loadString('local echoed = coroutine.yield(1, 2) return echoed')

        const seen = []
        const result = await thread.run(0, {
            onYield: (values) => {
                seen.push([...values])
                return values[0] + values[1]
            },
        })

        expect(seen).to.be.eql([[1, 2]])
        expect(result).to.be.eql([3])
    })

    it('onYield can resume with several values', async () => {
        using state = await getState()
        const thread = state.newThread()
        thread.loadString('local a, b = coroutine.yield() return a + b')

        const result = await thread.run(0, { onYield: () => LuaMultiReturn.of(4, 5) })
        expect(result).to.be.eql([9])
    })

    it('an unrepresentable top level yield does not crash the run', async () => {
        using state = await getState()
        const result = await state.doString('coroutine.yield(io.stdout) return 7')
        expect(result).to.be.equal(7)
    })

    it('a timeout interrupts a run parked on a promise promptly', async () => {
        using state = await getState()
        state.set('sleep', sleep)

        const started = Date.now()
        await expect(state.doString('sleep(1000):await() return 1', { timeout: 10 })).to.eventually.be.rejectedWith(LuaTimeoutError)
        expect(Date.now() - started, 'interrupted well before the promise settles').to.be.below(500)
    })

    it('an abort signal interrupts a parked run promptly', async () => {
        using state = await getState()
        state.set('sleep', sleep)
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 10)

        const started = Date.now()
        await expect(state.doString('sleep(1000):await() return 1', { signal: controller.signal })).to.eventually.be.rejectedWith(
            LuaAbortError,
        )
        expect(Date.now() - started).to.be.below(500)
    })

    it('a pcall around an interrupted await does not keep the run from reporting the interrupt', async () => {
        using state = await getState()
        state.set('sleep', sleep)

        // The interrupt is raised into Lua, so the pcall sees it; the run reports it all the same.
        await expect(
            state.doString('local ok = pcall(function() sleep(1000):await() end) return ok', { timeout: 10 }),
        ).to.eventually.be.rejectedWith(LuaTimeoutError)
    })

    it('an await reached after the interrupt is interrupted at once', async () => {
        using state = await getState()
        state.set('sleep', sleep)

        const started = Date.now()
        await expect(
            state.doString('for i = 1, 5 do pcall(function() sleep(1000):await() end) end', { timeout: 10 }),
        ).to.eventually.be.rejectedWith(LuaTimeoutError)
        expect(Date.now() - started, 'none of the later sleeps was waited for').to.be.below(500)
    })

    it('an interrupted await still closes the to-be-closed variables of the scopes it unwinds', async () => {
        using state = await getState()
        state.set('sleep', sleep)
        let closed = false
        state.set('markClosed', () => {
            closed = true
        })

        // Why the interrupt is an error raised into Lua rather than the run being dropped where it
        // stands: cleanup that the script registered gets to run.
        await expect(
            state.doString(
                `
                pcall(function()
                    local guard <close> = setmetatable({}, { __close = function() markClosed() end })
                    sleep(1000):await()
                end)
            `,
                { timeout: 10 },
            ),
        ).to.eventually.be.rejectedWith(LuaTimeoutError)
        expect(closed).to.be.equal(true)
    })

    describe('across a C-call boundary', () => {
        it('awaits inside a table.sort comparator', async () => {
            using state = await getState()
            state.set('sleep', (ms) => new Promise((resolve) => setTimeout(() => resolve(ms), ms)))
            const result = await state.doString(`
                local t = {3, 1, 2}
                table.sort(t, function(a, b) sleep(1):await() return a < b end)
                return table.concat(t, ",")
            `)
            expect(result).to.be.equal('1,2,3')
        })

        it('awaits inside a gsub callback', async () => {
            using state = await getState()
            state.set('sleep', (ms) => new Promise((resolve) => setTimeout(() => resolve(ms), ms)))
            const result = await state.doString(`return (("abc"):gsub(".", function(c) sleep(1):await() return c:upper() end))`)
            expect(result).to.be.equal('ABC')
        })

        it('awaits inside a promise:next callback', async () => {
            using state = await getState()
            state.set('sleep', (ms) => new Promise((resolve) => setTimeout(() => resolve(ms), ms)))
            const result = await state.doString(`
                return sleep(1):next(function() sleep(1):await() return 15 end):await()
            `)
            expect(result).to.be.equal(15)
        })

        it('awaits inside a coroutine nothing drives from the host', async () => {
            using state = await getState()
            state.set('sleep', (ms) => new Promise((resolve) => setTimeout(() => resolve(ms), ms)))
            const result = await state.doString(`
                local co = coroutine.wrap(function() return sleep(1):await() + 1 end)
                return co()
            `)
            expect(result).to.be.equal(2)
        })
    })

    it('awaits inside a generator do not surface as one of its values', async () => {
        using state = await getState()
        state.set('later', later)
        const result = await state.doString(`
            local values = coroutine.wrap(function()
                for i = 1, 3 do coroutine.yield(later(i * 10):await()) end
            end)
            return table.concat({ values(), values(), values() }, ",")
        `)
        expect(result).to.be.equal('10,20,30')
    })

    it('gives the C stack back when a run started inside another run outlives it', async () => {
        using state = await getState()
        const { module } = state
        state.set('sleep', sleep)
        const started = []
        state.set('start', () => {
            started.push(state.doString('sleep(1):await() return 1'))
        })

        for (let round = 0; round < 3; round++) {
            // Several C frames deep when the inner run starts, so its entry is far from the top.
            await state.doString(`
                local function deep(n)
                    if n == 0 then start() return end
                    pcall(string.gsub, "x", "x", function() deep(n - 1) end)
                end
                deep(10)
            `)
            expect(await Promise.all(started.splice(0))).to.be.eql([1])
            expect(module.stackSave(), `round ${round}`).to.be.equal(module.mainStackPointer)
        }
    })

    it('a state closed while a run is parked rejects rather than resuming into freed memory', async () => {
        using state = await getState()
        state.set('sleep', sleep)

        const running = state.doString('sleep(20):await() return 1')
        state.close()
        await expect(running).to.eventually.be.rejectedWith('the Lua state is closed')
    })
})

describe('Awaiting outside an async run', () => {
    it('is an error in a synchronous run', async () => {
        using state = await getState()
        state.set('ready', Promise.resolve(1))
        expect(() => state.doStringSync('return ready:await()')).to.throw('cannot await inside a synchronous call')
    })

    it('is an error in a Lua function called directly from JS', async () => {
        using state = await getState()
        state.set('ready', Promise.resolve(1))
        const fn = state.doStringSync('return function() return ready:await() end')
        expect(() => fn()).to.throw('make the function asynchronous with async(fn) in Lua or state.async(fn) in JS')
        // The failed call leaves the state usable.
        expect(await state.doString('return ready:await()')).to.be.equal(1)
    })

    it('reports a yield in a Lua function called directly from JS', async () => {
        using state = await getState()
        const fn = state.doStringSync('return function() coroutine.yield() end')
        expect(() => fn()).to.throw('cannot yield in a Lua function called synchronously')
        // The call thread is reusable afterwards.
        expect(state.doStringSync('return function() return 5 end')()).to.be.equal(5)
    })

    it('is an error everywhere on a platform without JSPI, where everything else still runs', async () => {
        const { Suspending } = WebAssembly
        WebAssembly.Suspending = undefined
        let runtime
        try {
            expect(LuaRuntime.canAwait).to.be.equal(false)
            runtime = await LuaRuntime.load()
        } finally {
            WebAssembly.Suspending = Suspending
        }
        await using lua = runtime
        using state = lua.createState()
        expect(lua.module.jspiSupported).to.be.equal(false)
        expect(LuaRuntime.canAwait).to.be.equal(true)

        state.set('ready', Promise.resolve(1))
        expect(await state.doString('return 1 + 1')).to.be.equal(2)
        expect(await state.doString('return coroutine.yield(20)', { onYield: ([value]) => value + 1 })).to.be.equal(21)
        expect(state.doStringSync('return function(a) return a * 2 end')(4)).to.be.equal(8)
        await expect(state.doString('return ready:await()')).to.eventually.be.rejectedWith('no WebAssembly JSPI support')
        // The failed await leaves the state usable.
        expect(await state.doString('return 3')).to.be.equal(3)
    })
})

describe('state.async', () => {
    it('runs a Lua function that awaits and resolves to its first result', async () => {
        using state = await getState()
        state.set('later', later)
        const fn = state.doStringSync('return function(a, b) return later(a):await() + b, "ignored" end')
        expect(await state.async(fn)(1, 2)).to.be.equal(3)
    })

    it('resolves to undefined for a function that returns nothing or nil, like a run does for nothing', async () => {
        using state = await getState()
        expect(await state.async(state.doStringSync('return function() end'))()).to.be.equal(undefined)
        expect(await state.async(state.doStringSync('return function() return nil end'))()).to.be.equal(undefined)
        expect(await state.doString('')).to.be.equal(undefined)
    })

    it('resolves to every result with returns all', async () => {
        using state = await getState()
        state.set('later', later)
        const fn = state.doStringSync('return function(a, b) return later(a):await() + b, nil, "kept" end')

        const values = await state.async(fn, { returns: 'all' })(1, 2)
        expect(values).to.be.instanceOf(LuaMultiReturn)
        expect(values).to.be.eql([3, undefined, 'kept'])
        expect(await state.async(state.doStringSync('return function() end'), { returns: 'all' })()).to.be.eql([])
    })

    it('returns a function to hand to whatever takes a callback', async () => {
        using state = await getState()
        state.set('later', later)
        const double = state.async(state.doStringSync('return function(value) return later(value):await() * 2 end'))
        expect(await Promise.all([1, 2, 3].map(double))).to.be.eql([2, 4, 6])
    })

    it('can await across a C-call boundary', async () => {
        using state = await getState()
        state.set('later', later)
        const sorted = state.doStringSync(`
            return function(t)
                table.sort(t, function(a, b) later(0):await() return a < b end)
                return table.concat(t, ",")
            end
        `)
        expect(await state.async(sorted)([3, 1, 2])).to.be.equal('1,2,3')
    })

    it('rejects with the Lua error the function raises', async () => {
        using state = await getState()
        state.set('later', later)
        const fn = state.doStringSync('return function() later(1):await() error("boom") end')
        await expect(state.async(fn)()).to.eventually.be.rejectedWith('boom')
    })

    it('runs overlapping calls of one function independently', async () => {
        using state = await getState()
        state.set('later', later)
        const fn = state.doStringSync('return function(value) return later(value):await() * 2 end')
        expect(await Promise.all([1, 2, 3].map((value) => state.async(fn)(value)))).to.be.eql([2, 4, 6])
        // Synchronous calls keep working while those are parked, and after.
        const pending = state.async(fn)(5)
        expect(state.doStringSync('return function(value) return value + 1 end')(1)).to.be.equal(2)
        expect(await pending).to.be.equal(10)
    })

    it('takes a timeout and a signal, which interrupt a parked call', async () => {
        using state = await getState()
        state.set('never', new Promise(() => {}))
        const fn = state.doStringSync('return function() never:await() end')

        await expect(state.async(fn, { timeout: 10 })()).to.eventually.be.rejectedWith(LuaTimeoutError)

        const controller = new AbortController()
        const aborted = expect(state.async(fn, { signal: controller.signal })()).to.eventually.be.rejectedWith(LuaAbortError)
        controller.abort()
        await aborted
    })

    it('falls back to the function timeout of the state', async () => {
        using state = await getState({ limits: { functionTimeout: 10 } })
        state.set('never', new Promise(() => {}))
        const fn = state.doStringSync('return function() never:await() end')
        await expect(state.async(fn)()).to.eventually.be.rejectedWith(LuaTimeoutError)
    })

    it('runs under the instruction budget of the state, like any other run', async () => {
        using state = await getState({ limits: { maxInstructions: 10_000 } })
        state.set('ready', Promise.resolve())
        const spin = state.doStringSync('return function() ready:await() while true do end end')

        await expect(state.async(spin)()).to.eventually.be.rejectedWith(LuaInstructionLimitError)
        await expect(
            state.doString('return async(function() ready:await() while true do end end)():await()'),
        ).to.eventually.be.rejectedWith(LuaInstructionLimitError)
        await expect(state.doStringSync('return ready:next(function() while true do end end)')).to.eventually.be.rejectedWith(
            LuaInstructionLimitError,
        )
    })

    it('only takes a Lua function of the same state', async () => {
        using state = await getState()
        using other = await getState()
        const foreign = other.doStringSync('return function() return 1 end')

        expect(state.isLuaFunction(state.doStringSync('return function() end'))).to.be.equal(true)
        expect(state.isLuaFunction(foreign)).to.be.equal(false)
        expect(state.isLuaFunction(() => 1)).to.be.equal(false)
        expect(() => state.async(() => 1)).to.throw(TypeError)
        expect(() => state.async(foreign)).to.throw(TypeError)
    })

    it('is what a promise calls its Lua reactions through, so they can await', async () => {
        using state = await getState()
        state.set('later', later)
        state.set('failed', () => Promise.reject(new Error('nope')))
        const result = await state.doString(`
            local log = {}
            local value = later(1)
                :next(function(v) return later(v + 1):await() end)
                :finally(function() later(0):await() log[#log + 1] = "finally" end)
                :await()
            local recovered = failed():catch(function() return later("recovered"):await() end):await()
            return table.concat({ value, recovered, log[1] }, ",")
        `)
        expect(result).to.be.equal('2,recovered,finally')
    })

    it('leaves a JS reaction handed through Lua as it was', async () => {
        using state = await getState()
        const seen = []
        state.set('ready', Promise.resolve(7))
        state.set('record', function (value) {
            seen.push([this, value])
            return value * 2
        })
        expect(await state.doString('return ready:next(record):await()')).to.be.equal(14)
        expect(seen).to.be.eql([[undefined, 7]])
    })
})

describe('async', () => {
    it('wraps a Lua function so that calling it starts a run and returns its promise', async () => {
        using state = await getState()
        state.set('later', later)
        expect(await state.doString('return async(function(a, b) return later(a):await() + b end)(1, 2):await()')).to.be.equal(3)
    })

    it('lets a function handed straight to a JS API await', async () => {
        using state = await getState()
        state.set('later', later)
        let outcome
        const called = new Promise((resolve) => {
            state.set('schedule', (callback) => {
                setTimeout(() => {
                    outcome = callback(20)
                    resolve()
                }, 1)
            })
        })
        await state.doString('schedule(async(function(x) return later(x):await() + 1 end))')
        await called
        expect(outcome).to.be.instanceOf(Promise)
        expect(await outcome).to.be.equal(21)
    })

    it('runs the calls it starts concurrently', async () => {
        using state = await getState()
        const order = []
        state.set('mark', (value) => void order.push(value))
        state.set('sleep', sleep)
        await state.doString(`
            local work = async(function(name, ms) mark(name .. " in") sleep(ms):await() mark(name .. " out") end)
            Promise.all({ work("slow", 20), work("fast", 1) }):await()
        `)
        expect(order).to.be.eql(['slow in', 'fast in', 'fast out', 'slow out'])
    })

    it('passes its arguments as the Lua values they are', async () => {
        // Under 'copy' a table that went through JS would come back as another table.
        using state = await getState({ objects: 'copy' })
        state.set('later', later)
        const result = await state.doString(`
            local t = {}
            local same = async(function(x) later(1):await() x.seen = true return x == t end)(t):await()
            return same and t.seen
        `)
        expect(result).to.be.equal(true)
    })

    it('can await across a C-call boundary and from a synchronous run', async () => {
        using state = await getState()
        state.set('later', later)
        const promise = state.doStringSync(`
            return async(function()
                local t = {3, 1, 2}
                table.sort(t, function(a, b) later(0):await() return a < b end)
                return table.concat(t, ",")
            end)()
        `)
        expect(promise).to.be.instanceOf(Promise)
        expect(await promise).to.be.equal('1,2,3')
    })

    it('rejects the promise with the error the function raises', async () => {
        using state = await getState()
        state.set('later', later)
        await expect(state.doString('return async(function() later(1):await() error("boom") end)():await()')).to.eventually.be.rejectedWith(
            'boom',
        )
    })

    it('runs under the function timeout of the state', async () => {
        using state = await getState({ limits: { functionTimeout: 10 } })
        state.set('never', new Promise(() => {}))
        await expect(state.doStringSync('return async(function() never:await() end)()')).to.eventually.be.rejectedWith(LuaTimeoutError)
    })

    it('only wraps a function', async () => {
        using state = await getState()
        await expect(state.doString('return async(42)')).to.eventually.be.rejectedWith('async expects a function, got number')
        await expect(state.doString('return async()')).to.eventually.be.rejectedWith('async expects a function, got no value')
    })

    it('gives nil back to Lua for a function that returned nil, not the truthy null sentinel', async () => {
        using state = await getState()
        state.set('later', later)
        const result = await state.doString(`
            local found = async(function() later(1):await() return nil end)():await()
            return found == nil and not found
        `)
        expect(result).to.be.equal(true)
    })

    it('hands a failure nothing was waiting on to onAsyncError instead of leaving it unhandled', async () => {
        const reported = []
        using state = await getState({ onAsyncError: (error) => reported.push(error) })
        state.set('later', later)
        // Called and forgotten, the way an event emitter or a timer treats its callback.
        state.set('fire', (callback) => void callback())

        await state.doString('fire(async(function() later(1):await() error("lost") end))')
        await sleep(20)
        expect(reported).to.have.length(1)
        expect(reported[0].message).to.include('lost')

        // Someone waiting on the promise gets the error, and the handler is left out of it.
        await expect(state.doString('return async(function() later(1):await() error("seen") end)():await()')).to.eventually.be.rejectedWith(
            'seen',
        )
        expect(
            await state.doString('return select(2, pcall(function() async(function() error("caught") end)():await() end)) ~= nil'),
        ).to.be.equal(true)
        await sleep(20)
        expect(reported).to.have.length(1)
    })

    it('can be injected on its own', async () => {
        using state = await getState({ inject: ['async', 'Promise'] })
        state.set('later', later)
        const types = await state.doString('return table.concat({ type(async), type(Promise), type(null), type(Error) }, ",")')
        expect(types).to.be.equal('function,table,nil,nil')
        // Without the null sentinel a JS null is nil in Lua.
        state.set('nothing', null)
        expect(await state.doString('return nothing == nil')).to.be.equal(true)
    })

    it('is not there without inject, and does not need the standard libraries', async () => {
        using plain = await getState({ inject: false })
        expect(plain.doStringSync('return async')).to.be.equal(undefined)

        using bare = await getState({ libs: false })
        bare.set('later', later)
        expect(await bare.doString('return async(function() return later(3):await() end)():await()')).to.be.equal(3)
    })
})

describe('Async run isolation', () => {
    it('keeps Node alive until queued continuations finish, then exits', () => {
        const entry = new URL('../dist/index.js', import.meta.url).href
        const stdout = execFileSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `
            import { LuaRuntime } from ${JSON.stringify(entry)}
            const runtime = await LuaRuntime.load()
            const state = runtime.createState()
            console.log(await state.doString('for i=1,1000 do coroutine.yield() end return 42'))
            state.close()
        `,
            ],
            { encoding: 'utf8', timeout: 5000 },
        )
        expect(stdout.trim()).to.equal('42')
    })

    it('a yielded promise is a host value, not an internal await', async () => {
        using state = await getState()
        const promise = new Promise(() => {})
        state.set('value', promise)
        let seen
        expect(
            await state.doString('return coroutine.yield(1, value)', {
                onYield: (values) => {
                    seen = values
                    return 42
                },
            }),
        ).to.equal(42)
        expect([...seen]).to.eql([1, promise])
    })

    it('keeps host yield results off the stack between resumes', async () => {
        using state = await getState()
        expect(
            await state.doString(
                `
            for i = 1, 1000 do
                local a, b = coroutine.yield(i, i + 1)
                assert(a == i * 2 and b == i * 3)
            end
            return 42
        `,
                { onYield: ([i]) => LuaMultiReturn.of(i * 2, i * 3) },
            ),
        ).to.equal(42)
    })

    it('gives the event loop a turn on every top level coroutine.yield without a handler', async () => {
        using state = await getState()
        let turns = 0
        let spinning = true
        const spin = () => {
            turns++
            if (spinning) {
                setImmediate(spin)
            }
        }
        setImmediate(spin)
        try {
            await state.doString('for i = 1, 50 do coroutine.yield() end')
        } finally {
            spinning = false
        }
        expect(turns).to.be.at.least(50)
    })

    it('lets timers run during repeated ready:await()', async () => {
        using state = await getState()
        state.set('ready', Promise.resolve())
        let fired = false
        state.set('fired', () => fired)
        const timer = setTimeout(() => {
            fired = true
        }, 0)
        try {
            expect(
                await state.doString(`
                for i = 1, 10000 do
                    ready:await()
                    if fired() then return true end
                end
                return false
            `),
            ).to.equal(true)
        } finally {
            clearTimeout(timer)
        }
    })

    it('keeps a deadline through a second await while another run is parked', async () => {
        using state = await getState()
        let releaseFirst, releaseOther
        state.set(
            'first',
            new Promise((resolve) => {
                releaseFirst = resolve
            }),
        )
        state.set(
            'other',
            new Promise((resolve) => {
                releaseOther = resolve
            }),
        )
        state.set('never', new Promise(() => {}))
        const timed = state.doString('first:await() never:await()', { timeout: 30 })
        const checked = expect(timed).to.eventually.be.rejectedWith(LuaTimeoutError)
        const other = state.doString('other:await() return 42')
        releaseFirst()
        await checked
        releaseOther()
        expect(await other).to.equal(42)
    })

    it('keeps abort signals isolated across states sharing a module', async () => {
        using state = await getState()
        using other = new state.constructor(state.module)
        let releaseFirst, reachedSecond
        state.set(
            'first',
            new Promise((resolve) => {
                releaseFirst = resolve
            }),
        )
        state.set('never', new Promise(() => {}))
        const second = new Promise((resolve) => {
            reachedSecond = resolve
        })
        state.set('second', reachedSecond)
        const controller = new AbortController()
        const checked = expect(
            state.doString('first:await() second() never:await()', {
                signal: controller.signal,
            }),
        ).to.eventually.be.rejectedWith(LuaAbortError)
        const otherRun = other.doString('coroutine.yield() return 7')
        releaseFirst()
        await second
        controller.abort()
        await checked
        expect(await otherRun).to.equal(7)
    })

    it('does not lose a caught interrupt when Lua starts another run', async () => {
        using state = await getState()
        state.set('never', new Promise(() => {}))
        let nested
        state.set('start', () => {
            nested = state.doString('return 7')
        })
        await expect(
            state.doString(
                `
            pcall(function() never:await() end)
            start()
            return 42
        `,
                { timeout: 10 },
            ),
        ).to.eventually.be.rejectedWith(LuaTimeoutError)
        expect(await nested).to.equal(7)
    })

    it('interrupts a parked onYield handler', async () => {
        using state = await getState()
        await expect(
            state.doString('coroutine.yield() return 42', {
                timeout: 10,
                onYield: () => new Promise(() => {}),
            }),
        ).to.eventually.be.rejectedWith(LuaTimeoutError)
    })

    it('does not overflow a long deadline while parked', async () => {
        using state = await getState()
        state.set('delayed', new Promise((resolve) => setTimeout(() => resolve(42), 10)))
        expect(await state.doString('return delayed:await()', { timeout: 0x80000000 })).to.equal(42)
    })

    it('can abort a loop of immediately settled awaits', async () => {
        using state = await getState()
        state.set('ready', Promise.resolve())
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 0)
        try {
            await expect(
                state.doString('while true do ready:await() end', {
                    signal: controller.signal,
                    timeout: 1000,
                }),
            ).to.eventually.be.rejectedWith(LuaAbortError)
        } finally {
            clearTimeout(timer)
        }
    })

    it('rejects all parked runs and callbacks when the state closes', async () => {
        using state = await getState()
        state.set('never', new Promise(() => {}))
        state.doStringSync('function callback() never:await() end')
        const runs = [
            state.doString('never:await()'),
            state.doString('never:await()'),
            state.async(state.get('callback'))(),
            state.async(state.get('callback'))(),
            state.doString('coroutine.yield()', { onYield: () => new Promise(() => {}) }),
        ]
        const checked = runs.map((run) => expect(run).to.eventually.be.rejectedWith('the Lua state is closed'))
        state.close()
        await Promise.all(checked)
    })

    it('rejects a second run on an already running thread', async () => {
        using state = await getState()
        state.set('never', new Promise(() => {}))
        const thread = state.newThread()
        thread.loadString('never:await()')
        const first = thread.run()
        const checked = expect(first).to.eventually.be.rejectedWith('the Lua state is closed')
        await expect(thread.run()).to.eventually.be.rejectedWith('already running')
        thread.close()
        await checked
    })

    it('does not marshal a settled await into a state closed before resumption', async () => {
        for (let depth = 0; depth < 12; depth++) {
            using state = await getState()
            let release
            state.set(
                'gate',
                new Promise((resolve) => {
                    release = resolve
                }),
            )
            const pushNil = state.module.lua_pushnil
            let touchedClosedState = false
            state.module.lua_pushnil = (address) => {
                if (state.isClosed()) {
                    touchedClosedState = true
                    throw new Error('attempted to marshal into a closed state')
                }
                return pushNil(address)
            }
            try {
                const observed = state.doString('gate:await() return 42').then(
                    (value) => value,
                    (error) => error.message,
                )
                release()
                for (let i = 0; i < depth; i++) await Promise.resolve()
                state.close()
                expect(await observed).to.be.oneOf([42, 'the Lua state is closed'])
                // The close listener can reject the run before its native continuation reacts.
                for (let i = 0; i < 10; i++) await Promise.resolve()
                expect(touchedClosedState, `close at microtask ${depth}`).to.equal(false)
            } finally {
                state.module.lua_pushnil = pushNil
            }
        }
    })

    it('can interleave many runs with different suspension depths and settlement orders', async () => {
        using state = await getState()
        state.set('pause', () => Promise.resolve())
        const runs = Array.from({ length: 32 }, (_, i) =>
            state.doString(`
            local function recurse(n)
                if n > 0 then return n + recurse(n - 1) end
                for j = 1, 50 do pause():await() end
                return ${i}
            end
            return recurse(${i})
        `),
        )
        expect(await Promise.all(runs)).to.eql(Array.from({ length: 32 }, (_, i) => i + (i * (i + 1)) / 2))
    })
})
