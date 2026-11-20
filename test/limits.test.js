import { LuaInterruptError, LuaTimeoutError, LuaInstructionLimitError, LuaAbortError } from '../dist/index.js'
import { expect } from 'chai'
import { getState } from './utils.js'

describe('Run limits', () => {
    const busyLoop = 'local x = 0 for i = 1, 1e9 do x = x + 1 end return x'
    const countingLoop = 'i = 0 while true do i = i + 1 end'
    const instructionsPerIteration = 4

    it('timeout interrupts a tight loop', async function () {
        this.timeout(20_000)
        using state = await getState()

        await expect(state.doString(busyLoop, { timeout: 20 })).to.eventually.be.rejectedWith(LuaTimeoutError)
    })

    it('maxInstructions interrupts a tight loop', async function () {
        this.timeout(20_000)
        using state = await getState()

        await expect(state.doString(busyLoop, { maxInstructions: 5_000 })).to.eventually.be.rejectedWith(LuaInstructionLimitError)
    })

    it('maxInstructions stops inside the budget rather than a hook period past it', async function () {
        this.timeout(20_000)

        for (const maxInstructions of [500, 1_000, 1_500, 5_000]) {
            using state = await getState()

            await expect(state.doString(countingLoop, { maxInstructions })).to.eventually.be.rejectedWith(LuaInstructionLimitError)

            const executed = state.get('i') * instructionsPerIteration
            expect(executed, `budget of ${maxInstructions}`).to.be.at.most(maxInstructions)
            expect(executed, `budget of ${maxInstructions}`).to.be.above(maxInstructions - 2 * instructionsPerIteration)
        }
    })

    it('an already aborted signal stops the run', async function () {
        this.timeout(20_000)
        using state = await getState()

        await expect(state.doString(busyLoop, { signal: AbortSignal.abort() })).to.eventually.be.rejectedWith(LuaAbortError)
    })

    it('a signal aborted while parked on a promise stops the run', async function () {
        this.timeout(20_000)
        using state = await getState()
        state.set('sleep', (ms) => new Promise((resolve) => setTimeout(resolve, ms)))
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 5)

        await expect(state.doString('sleep(30):await() return 1', { signal: controller.signal })).to.eventually.be.rejectedWith(
            LuaAbortError,
        )
    })

    it('maxInstructions from the state options applies to every run', async function () {
        this.timeout(20_000)
        using state = await getState({ limits: { maxInstructions: 5_000 } })

        await expect(state.doString(busyLoop)).to.eventually.be.rejectedWith(LuaInstructionLimitError)
        expect(await state.doString('return 1 + 1')).to.be.equal(2)
    })

    it('state.limits reaches both the sync and the async path', async function () {
        this.timeout(20_000)
        using state = await getState()
        state.limits = { maxInstructions: 5_000 }

        await expect(state.doString(busyLoop)).to.eventually.be.rejectedWith(LuaInstructionLimitError)
        expect(() => state.doStringSync(busyLoop)).to.throw(LuaInstructionLimitError)

        // A field of it changes the same way as the whole.
        state.limits.maxInstructions = undefined
        state.limits.timeout = 20
        await expect(state.doString(busyLoop)).to.eventually.be.rejectedWith(LuaTimeoutError)
        expect(() => state.doStringSync(busyLoop)).to.throw(LuaTimeoutError)
    })

    it('state.limits starts as a copy of the limits the state was created with', async () => {
        const limits = { timeout: 1000, maxInstructions: 5_000 }
        using state = await getState({ limits })

        expect(state.limits).to.be.eql(limits)
        state.limits.timeout = 5
        expect(limits.timeout).to.be.equal(1000)

        state.limits = undefined
        expect(state.limits).to.be.eql({})
    })

    it('a parked run keeps the limits it started under when the ones of the state change', async () => {
        using state = await getState()
        let release
        state.set(
            'gate',
            new Promise((resolve) => {
                release = resolve
            }),
        )
        state.limits.timeout = 60_000
        const pending = state.doString('gate:await() return 42')
        state.limits.timeout = 0
        release()
        expect(await pending).to.equal(42)
        await expect(state.doString('gate:await()')).to.eventually.be.rejectedWith(LuaTimeoutError)
    })

    it('every limit shares one catchable base', async function () {
        this.timeout(20_000)
        using state = await getState()

        for (const options of [{ timeout: 20 }, { maxInstructions: 5_000 }, { signal: AbortSignal.abort() }]) {
            await expect(state.doString(busyLoop, options)).to.eventually.be.rejectedWith(LuaInterruptError)
        }
    })

    it('the limits of a run replace the ones of the state field by field', async function () {
        this.timeout(20_000)
        using state = await getState({ limits: { maxInstructions: 5_000 } })

        // The budget is replaced, so the loop below fits. No timeout came from either side.
        expect(await state.doString('local x = 0 for i = 1, 20000 do x = x + 1 end return x', { maxInstructions: 1_000_000 })).to.be.equal(
            20000,
        )
        // The timeout is added, and the budget of the state still applies.
        await expect(state.doString(busyLoop, { timeout: 60_000 })).to.eventually.be.rejectedWith(LuaInstructionLimitError)
        // Infinity lifts it.
        expect(await state.doString('local x = 0 for i = 1, 20000 do x = x + 1 end return x', { maxInstructions: Infinity })).to.be.equal(
            20000,
        )
        expect(state.limits).to.be.eql({ maxInstructions: 5_000 })
    })

    it('a run leaves no hook behind on the thread it used', async () => {
        using state = await getState()

        state.doStringSync('return 1', { maxInstructions: 10_000 })

        expect(state.module.lua_gethook(state.address)).to.be.equal(0)
    })

    describe('every kind of run', () => {
        const spin = 'while true do end'

        it('a call of a Lua function is under the limits of the state', async function () {
            this.timeout(20_000)
            using state = await getState()
            const fn = state.doStringSync(`return function() ${spin} end`)

            state.limits = { timeout: 20 }
            expect(() => fn()).to.throw(LuaTimeoutError)

            state.limits = { maxInstructions: 5_000 }
            expect(() => fn()).to.throw(LuaInstructionLimitError)

            state.limits = { signal: AbortSignal.abort() }
            expect(() => fn()).to.throw(LuaAbortError)
        })

        it('a call by name is under the limits of the state', async function () {
            this.timeout(20_000)
            using state = await getState({ limits: { maxInstructions: 5_000 } })
            state.doStringSync(`function spin() ${spin} end`)

            expect(() => state.call('spin')).to.throw(LuaInstructionLimitError)
        })

        it('a function that timed out does not put the next call beyond the limit', async function () {
            this.timeout(20_000)
            using state = await getState({ limits: { timeout: 20 } })
            const fn = state.doStringSync(`return function() ${spin} end`)

            // Lua leaves the debug hook disabled on a thread a hook raised an error out of, and
            // calls reuse one thread: the second call used to run with no limit at all.
            for (let call = 0; call < 3; call++) {
                expect(() => fn(), `call ${call}`).to.throw(LuaTimeoutError)
            }
            expect(state.doStringSync('return 1 + 1')).to.be.equal(2)
        })

        it('a function that caught its interrupt keeps the limit for the next call', async function () {
            this.timeout(20_000)
            using state = await getState({ limits: { maxInstructions: 5_000 } })
            const caught = state.doStringSync(`return function() return (pcall(function() ${spin} end)) end`)
            const fn = state.doStringSync(`return function() ${spin} end`)

            // The pcall swallows the interrupt and the function returns before the hook fires again.
            expect(caught()).to.be.equal(false)
            expect(() => fn()).to.throw(LuaInstructionLimitError)
            expect(() => fn()).to.throw(LuaInstructionLimitError)
        })
    })

    describe('a run made from inside another', () => {
        const spin = 'while true do end'

        // The run on the stack is a doString with limits of its own; the function below is what
        // Lua hands to JS, which calls it back synchronously on another thread.
        const callBack = (state, options, script = `each(function() ${spin} end)`) => {
            state.set('each', (fn) => fn())
            return state.doString(script, options)
        }

        it('cannot outlast the timeout of the outer one', async function () {
            this.timeout(20_000)
            using state = await getState()

            await expect(callBack(state, { timeout: 20 })).to.eventually.be.rejectedWith(LuaTimeoutError)
        })

        it('spends from the instruction budget of the outer one', async function () {
            this.timeout(20_000)
            using state = await getState()

            await expect(callBack(state, { maxInstructions: 5_000 })).to.eventually.be.rejectedWith(LuaInstructionLimitError)
        })

        it('is aborted by the signal of the outer one', async function () {
            this.timeout(20_000)
            using state = await getState()

            await expect(callBack(state, { signal: AbortSignal.abort() })).to.eventually.be.rejectedWith(LuaAbortError)
        })

        it('counts what it executed against the outer one', async function () {
            this.timeout(20_000)
            // Each call back stays inside the budget on its own, and together they do not.
            using state = await getState()
            const run = callBack(
                state,
                { maxInstructions: 20_000 },
                'for _ = 1, 100 do each(function() local x = 0 for i = 1, 2000 do x = x + 1 end end) end',
            )

            await expect(run).to.eventually.be.rejectedWith(LuaInstructionLimitError)
        })

        it('is interrupted where the JS function that made it can see', async function () {
            this.timeout(20_000)
            using state = await getState()
            let seen
            state.set('each', (fn) => {
                try {
                    fn()
                } catch (error) {
                    seen = error
                    throw error
                }
            })

            await expect(state.doString(`each(function() ${spin} end)`, { timeout: 20 })).to.eventually.be.rejectedWith(LuaTimeoutError)
            expect(seen).to.be.an.instanceOf(LuaTimeoutError)
        })

        it('still has the limits of the state when the outer one has none', async function () {
            this.timeout(20_000)
            using state = await getState({ limits: { maxInstructions: 5_000 } })
            state.set('each', (fn) => fn())

            await expect(state.doString(`each(function() ${spin} end)`, { maxInstructions: Infinity })).to.eventually.be.rejectedWith(
                LuaInstructionLimitError,
            )
        })

        it('through doStringSync on the same thread stays inside the outer one too', async function () {
            this.timeout(20_000)
            using state = await getState()
            state.set('nested', () => state.doStringSync(spin))

            expect(() => state.doStringSync('nested()', { timeout: 20 })).to.throw(LuaTimeoutError)
            expect(() => state.doStringSync('nested()', { maxInstructions: 5_000 })).to.throw(LuaInstructionLimitError)
            expect(state.module.lua_gethook(state.address)).to.be.equal(0)
        })

        it('an asynchronous run started from inside another is on its own', async function () {
            this.timeout(20_000)
            using state = await getState()
            state.set('sleep', (ms) => new Promise((resolve) => setTimeout(resolve, ms)))

            // The outer run returns the promise without waiting, well inside its 20ms; the run it
            // started goes on for longer than that and is not cut short by it.
            const started = await state.doString('return async(function() sleep(60):await() return "finished" end)()', { timeout: 20 })

            expect(started).to.be.equal('finished')
        })
    })

    it('a thread that a limit interrupted cannot be reset', async function () {
        this.timeout(20_000)
        using state = await getState()
        const thread = state.newThread()
        thread.loadString(busyLoop)
        await expect(thread.run(0, { timeout: 20 })).to.eventually.be.rejectedWith(LuaTimeoutError)

        // Lua leaves the hook of such a thread disabled, so a limit on its next run would be ignored.
        expect(() => thread.resetThread()).to.throw('a thread that a limit interrupted cannot be reset')
    })

    // An interrupt is raised as a token rather than as a JS error pushed into Lua, so that reporting
    // it does not depend on how the state marshals anything.
    describe('state configurations', () => {
        const configs = [
            ['the default proxy state', {}],
            ['objects: copy', { objects: 'copy' }],
            ['no injected globals', { inject: false }],
            ['no standard libraries', { libs: false }],
            ['no libraries and nothing injected', { libs: false, objects: 'copy', inject: false }],
        ]

        for (const [description, config] of configs) {
            it(`reports every interrupt as itself in ${description}`, async function () {
                this.timeout(20_000)
                using state = await getState(config)

                await expect(state.doString(busyLoop, { maxInstructions: 5_000 })).to.eventually.be.rejectedWith(LuaInstructionLimitError)
                await expect(state.doString(busyLoop, { timeout: 20 })).to.eventually.be.rejectedWith(LuaTimeoutError)
                await expect(state.doString(busyLoop, { signal: AbortSignal.abort() })).to.eventually.be.rejectedWith(LuaAbortError)
                expect(() => state.doStringSync(busyLoop, { maxInstructions: 5_000 })).to.throw(LuaInstructionLimitError)
            })
        }
    })

    it('an interrupt the script caught does not stand in for the error that followed', async function () {
        this.timeout(20_000)
        using state = await getState({ objects: 'copy' })

        // The budget is spent inside the pcall, so the interrupt is raised and swallowed there. The
        // hook re-raises within another hookCount instructions, which is room enough for the error
        // below and nothing much else.
        const failure = state.doString(
            `pcall(function () ${busyLoop} end)
             error('raised after the interrupt was caught')`,
            { maxInstructions: 5_000 },
        )

        await expect(failure).to.eventually.be.rejected.then((error) => {
            expect(error).to.not.be.an.instanceOf(LuaInterruptError)
            expect(error.message).to.contain('raised after the interrupt was caught')
        })
    })

    it('an interrupt inside a coroutine unwinds the coroutine too', async function () {
        this.timeout(20_000)
        using state = await getState()

        const outcome = state.doStringSync(
            `local co = coroutine.create(function () ${busyLoop} end)
             local ok = coroutine.resume(co)
             return tostring(ok) .. " " .. coroutine.status(co)`,
            { maxInstructions: 5_000 },
        )

        expect(outcome).to.be.equal('false dead')
    })

    it('an interrupt token the script kept does not turn a later run into a limit error', async function () {
        this.timeout(20_000)
        using state = await getState({ objects: 'copy' })

        state.doStringSync(`local ok, token = pcall(function () ${busyLoop} end) saved = token`, { maxInstructions: 5_000 })

        let error
        try {
            state.doStringSync('error(saved)')
        } catch (err) {
            error = err
        }

        expect(error).to.be.an('error')
        expect(error).to.not.be.an.instanceOf(LuaInterruptError)
    })
})
