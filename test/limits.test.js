import { LuaInterruptError, LuaTimeoutError, LuaInstructionLimitError, LuaAbortError } from '../dist/index.js'
import { expect } from 'chai'
import { getState } from './utils.js'

describe('Run limits', () => {
    const busyLoop = 'local x = 0 for i = 1, 1e9 do x = x + 1 end return x'

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

    it('setLimits on the state reaches both the sync and the async path', async function () {
        this.timeout(20_000)
        using state = await getState()
        state.setLimits({ maxInstructions: 5_000 })

        await expect(state.doString(busyLoop)).to.eventually.be.rejectedWith(LuaInstructionLimitError)
        expect(() => state.doStringSync(busyLoop)).to.throw(LuaInstructionLimitError)
    })

    it('every limit shares one catchable base', async function () {
        this.timeout(20_000)
        using state = await getState()

        for (const options of [{ timeout: 20 }, { maxInstructions: 5_000 }, { signal: AbortSignal.abort() }]) {
            await expect(state.doString(busyLoop, options)).to.eventually.be.rejectedWith(LuaInterruptError)
        }
    })

    it('limits are restored after a scoped run', async () => {
        using state = await getState()
        state.setLimits({ maxInstructions: 999 })

        await state.doString('return 1', { maxInstructions: 10_000 })

        expect(state.getLimits().maxInstructions).to.be.equal(999)
    })

    // An interrupt used to be pushed into Lua as a JS error and recognised on the way back out by
    // its identity, which only survived in a state whose extensions marshal an Error by reference.
    // `objects: 'copy'` with `errors: false` -- a sandbox that keeps JS errors away from Lua, and so
    // exactly the state most likely to set a limit in the first place -- turned every interrupt into
    // an opaque `LuaError: table: 0x...`.
    describe('state configurations', () => {
        const configs = [
            ['the default proxy state', {}],
            ['objects: copy', { objects: 'copy' }],
            ['objects: copy with errors off', { objects: 'copy', errors: false }],
            ['no injected globals', { inject: false }],
            ['no standard libraries', { libs: false }],
            ['no libraries and nothing to marshal errors', { libs: false, objects: 'copy', errors: false, inject: false }],
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
        using state = await getState({ objects: 'copy', errors: false })

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
        using state = await getState({ objects: 'copy', errors: false })

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
