import { execFileSync } from 'node:child_process'
import { use } from 'chai'
import chaiAsPromised from 'chai-as-promised'

use(chaiAsPromised)
import { expect } from 'chai'
import { LuaRuntime, LuaTimeoutError, LuaAbortError, LuaMultiReturn } from '../dist/index.js'
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

// Run with WASMOON_ASYNC=yield and WASMOON_ASYNC=jspi; the same contract must hold under both.
describe('Async run isolation', () => {
    it('preserves automatic engine selection', async () => {
        await using runtime = await LuaRuntime.load()
        expect(runtime.module.useJspi).to.equal(runtime.module.jspiSupported)
    })

    it('keeps Node alive until queued continuations finish, then exits', () => {
        const entry = new URL('../dist/index.js', import.meta.url).href
        const stdout = execFileSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `
            import { LuaRuntime } from ${JSON.stringify(entry)}
            const runtime = await LuaRuntime.load({ async: 'yield' })
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

    for (const expression of ['ready:await()', 'coroutine.yield()']) {
        it(`lets timers run during repeated ${expression}`, async () => {
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
                        ${expression}
                        if fired() then return true end
                    end
                    return false
                `),
                ).to.equal(true)
            } finally {
                clearTimeout(timer)
            }
        })
    }

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
        if (!state.module.useJspi) return
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
            state.get('callback')(),
            state.get('callback')(),
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
