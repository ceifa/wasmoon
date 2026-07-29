import { LuaRuntime, LuaError, decorate } from '../dist/index.js'
import { expect } from 'chai'
import { getState } from './utils.js'

describe('LuaError', () => {
    it('keeps the raised value, message and traceback apart', async () => {
        using state = await getState()

        try {
            await state.doString(`error({ code = 7 })`)
            throw new Error('should not be reached')
        } catch (err) {
            expect(err).to.be.instanceOf(LuaError)
            expect(err.code).to.be.equal(2)
            expect(err.luaValue).to.be.eql({ code: 7 })
            expect(err.message).to.not.include('stack traceback:')
            expect(err.traceback).to.include('stack traceback:')
        }
    })

    it('a JS error thrown through Lua keeps its own stack', async () => {
        using state = await getState()
        const thrown = new Error('from js')
        state.set('boom', () => {
            throw thrown
        })

        try {
            await state.doString('boom()')
            throw new Error('should not be reached')
        } catch (err) {
            expect(err.luaValue).to.be.equal(thrown)
            expect(err.stack).to.be.equal(thrown.stack)
        }
    })
})

describe('errors option', () => {
    const setThrow = (state) =>
        state.set('boom', () => {
            throw new Error('kaboom')
        })
    const catchIt = (expression) => `local ok, err = pcall(boom) return ${expression}`

    // The "Error: " prefix is the tell: js_error renders the bare message, the proxy layer
    // leaves tostring to Error.prototype.
    const matrix = [
        ['off by default', undefined, 'Error: kaboom'],
        ['on when asked for', { errors: true }, 'kaboom'],
        // errors used to sit below proxy, so opting in while leaving objects alone did nothing.
        ['on when asked for even though objects is proxy', { objects: 'proxy', errors: true }, 'kaboom'],
        ['on by default when objects is copy', { objects: 'copy' }, 'kaboom'],
    ]

    for (const [name, options, expected] of matrix) {
        it(`should be ${name}`, async () => {
            using state = await getState(options)
            setThrow(state)

            expect(await state.doString(catchIt('tostring(err)'))).to.be.equal(expected)
        })
    }

    it('should leave the real properties reachable when off', async () => {
        using state = await getState()
        setThrow(state)

        expect(await state.doString(catchIt('type(err.stack)'))).to.be.equal('string')
    })

    it('should expose the message when on', async () => {
        using state = await getState({ errors: true })
        setThrow(state)

        expect(await state.doString(catchIt('err.message'))).to.be.equal('kaboom')
    })

    it('should be overridable to off when objects is copy', async () => {
        using state = await getState({ objects: 'copy', errors: false })
        setThrow(state)

        expect(await state.doString(catchIt('type(err)'))).to.be.equal('table')
    })

    // Claiming every Error on type alone would swallow these, the way proxy used to swallow it.
    describe('should defer to an explicit decoration', () => {
        const cases = [
            ['userdata', 'userdata', 'js_userdata'],
            ['proxy', 'userdata', 'Error: kaboom'],
            ['value', 'table', 'table:'],
        ]

        for (const [as, luaType, rendering] of cases) {
            it(`as: '${as}'`, async () => {
                using state = await getState({ errors: true })
                state.set('decorated', decorate(new Error('kaboom'), { as }))

                expect(await state.doString('return type(decorated)')).to.be.equal(luaType)
                expect(await state.doString('return tostring(decorated)')).to.include(rendering)
            })
        }
    })

    it('should expose an Error constructor to lua when injecting', async () => {
        using state = await getState({ errors: true })

        expect(await state.doString('return tostring(Error.create("made in lua"))')).to.be.equal('made in lua')
        expect(await state.doString('return Error.create("made in lua").message')).to.be.equal('made in lua')
    })

    it('should not expose the Error constructor when the extension is off', async () => {
        using state = await getState()

        expect(await state.doString('return type(Error)')).to.be.equal('nil')
    })
})

describe('Unrepresentable values', () => {
    it('getValue throws instead of returning an opaque handle', async () => {
        using state = await getState()
        const thread = state.newThread()
        thread.lua.lua_newuserdatauv(thread.address, 4, 0)

        expect(() => thread.getValue(-1)).to.throw('has no JS representation')
    })

    it('the address is still reachable through getPointer', async () => {
        using state = await getState()
        const thread = state.newThread()
        thread.lua.lua_newuserdatauv(thread.address, 4, 0)

        expect(thread.getPointer(-1)).to.be.greaterThan(0)
    })
})

describe('Warnings', () => {
    it('onWarn receives diagnostics instead of the console', async () => {
        const lua = await LuaRuntime.load()
        const seen = []
        using state = lua.createState({ onWarn: (message) => seen.push(message) })

        state.getTable('_G', () => {
            // Leaves the stack unbalanced on purpose.
            state.lua.lua_pushnil(state.address)
        })

        expect(seen).to.have.lengthOf(1)
        expect(seen[0]).to.include('getTable: expected stack size')
    })
})
