import { LuaInterruptError, LuaTimeoutError, LuaInstructionLimitError, LuaAbortError } from '../dist/index.js'
import { expect } from 'chai'
import { getState } from './utils.js'

describe('Run limits', () => {
    const busyLoop = 'local x = 0 for i = 1, 1e9 do x = x + 1 end return x'

    it('timeout interrupts a tight loop', async function () {
        this.timeout(20_000)
        const state = await getState()

        await expect(state.doString(busyLoop, { timeout: 20 })).to.eventually.be.rejectedWith(LuaTimeoutError)
    })

    it('maxInstructions interrupts a tight loop', async function () {
        this.timeout(20_000)
        const state = await getState()

        await expect(state.doString(busyLoop, { maxInstructions: 5_000 })).to.eventually.be.rejectedWith(LuaInstructionLimitError)
    })

    it('an already aborted signal stops the run', async function () {
        this.timeout(20_000)
        const state = await getState()

        await expect(state.doString(busyLoop, { signal: AbortSignal.abort() })).to.eventually.be.rejectedWith(LuaAbortError)
    })

    it('a signal aborted while parked on a promise stops the run', async function () {
        this.timeout(20_000)
        const state = await getState()
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
        const state = await getState()
        state.setLimits({ maxInstructions: 999 })

        await state.doString('return 1', { maxInstructions: 10_000 })

        expect(state.getLimits().maxInstructions).to.be.equal(999)
    })
})
