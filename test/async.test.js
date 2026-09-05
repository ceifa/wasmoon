import { use } from 'chai'
import chaiAsPromised from 'chai-as-promised'

use(chaiAsPromised)
import { expect } from 'chai'
import { LuaTimeoutError, LuaAbortError, LuaMultiReturn } from '../dist/index.js'
import { getState } from './utils.js'

describe('Async engine', () => {
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

    it('an unrepresentable top level yield no longer crashes the run', async () => {
        using state = await getState()
        const result = await state.doString('coroutine.yield(io.stdout) return 7')
        expect(result).to.be.equal(7)
    })

    it('a timeout interrupts a run parked on a promise promptly', async () => {
        using state = await getState()
        state.set('sleep', (ms) => new Promise((resolve) => setTimeout(resolve, ms)))

        const started = Date.now()
        await expect(state.doString('sleep(1000):await() return 1', { timeout: 10 })).to.eventually.be.rejectedWith(LuaTimeoutError)
        expect(Date.now() - started, 'interrupted well before the promise settles').to.be.below(500)
    })

    it('an abort signal interrupts a parked run promptly', async () => {
        using state = await getState()
        state.set('sleep', (ms) => new Promise((resolve) => setTimeout(resolve, ms)))
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 10)

        const started = Date.now()
        await expect(state.doString('sleep(1000):await() return 1', { signal: controller.signal })).to.eventually.be.rejectedWith(
            LuaAbortError,
        )
        expect(Date.now() - started).to.be.below(500)
    })

    it('interrupting a parked await is catchable by pcall on a fresh run', async () => {
        using state = await getState()
        state.set('sleep', (ms) => new Promise((resolve) => setTimeout(resolve, ms)))

        // The interrupt unwinds like a limit error: a pcall inside the script cannot swallow it.
        await expect(
            state.doString('local ok = pcall(function() sleep(1000):await() end) return ok', { timeout: 10 }),
        ).to.eventually.be.rejectedWith(LuaTimeoutError)
    })

    describe('across a C-call boundary', () => {
        const itJspi = (name, fn) => {
            it(name, async function () {
                using state = await getState()
                if (!state.module.useJspi) {
                    this.skip()
                }
                await fn(state)
            })
        }

        itJspi('awaits inside a table.sort comparator', async (state) => {
            state.set('sleep', (ms) => new Promise((resolve) => setTimeout(() => resolve(ms), ms)))
            const result = await state.doString(`
                local t = {3, 1, 2}
                table.sort(t, function(a, b) sleep(1):await() return a < b end)
                return table.concat(t, ",")
            `)
            expect(result).to.be.equal('1,2,3')
        })

        itJspi('awaits inside a gsub callback', async (state) => {
            state.set('sleep', (ms) => new Promise((resolve) => setTimeout(() => resolve(ms), ms)))
            const result = await state.doString(`return (("abc"):gsub(".", function(c) sleep(1):await() return c:upper() end))`)
            expect(result).to.be.equal('ABC')
        })

        itJspi('awaits inside a promise:next callback', async (state) => {
            state.set('sleep', (ms) => new Promise((resolve) => setTimeout(() => resolve(ms), ms)))
            const result = await state.doString(`
                return sleep(1):next(function() sleep(1):await() return 15 end):await()
            `)
            expect(result).to.be.equal(15)
        })

        itJspi('awaits inside a coroutine nothing drives from the host', async (state) => {
            state.set('sleep', (ms) => new Promise((resolve) => setTimeout(() => resolve(ms), ms)))
            const result = await state.doString(`
                local co = coroutine.wrap(function() return sleep(1):await() + 1 end)
                return co()
            `)
            expect(result).to.be.equal(2)
        })
    })

    it('a state closed while a JSPI run is parked rejects rather than resuming into freed memory', async () => {
        using state = await getState()
        if (!state.module.useJspi) {
            return
        }
        state.set('sleep', (ms) => new Promise((resolve) => setTimeout(resolve, ms)))

        const running = state.doString('sleep(20):await() return 1')
        state.close()
        await expect(running).to.eventually.be.rejectedWith('the Lua state is closed')
    })
})
