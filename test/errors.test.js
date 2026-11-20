import { LuaRuntime, LuaError, copy, opaque, proxy } from '../dist/index.js'
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

describe('JS errors in Lua', () => {
    const setThrow = (state, error = new Error('kaboom')) =>
        state.set('boom', () => {
            throw error
        })
    const catchIt = (expression) => `local ok, err = pcall(boom) return ${expression}`

    // The bare message is the tell: the proxy layer would leave tostring to Error.prototype, which
    // prefixes it with "Error: ".
    for (const [name, options] of [
        ['a state that proxies its objects', { objects: 'proxy' }],
        ['a state that copies its objects', { objects: 'copy' }],
    ]) {
        it(`should render as the message in ${name}`, async () => {
            using state = await getState(options)
            setThrow(state)

            expect(await state.doString(catchIt('type(err)'))).to.be.equal('userdata')
            expect(await state.doString(catchIt('tostring(err)'))).to.be.equal('kaboom')
        })
    }

    it('should expose the message, name and stack', async () => {
        using state = await getState()
        setThrow(state)

        expect(await state.doString(catchIt('err.message'))).to.be.equal('kaboom')
        expect(await state.doString(catchIt('err.name'))).to.be.equal('Error')
        expect(await state.doString(catchIt('type(err.stack)'))).to.be.equal('string')
    })

    it('should expose what the error carries as its own properties', async () => {
        using state = await getState()
        setThrow(state, Object.assign(new Error('not found', { cause: new Error('root') }), { code: 'ENOENT', errno: -2 }))

        expect(await state.doString(catchIt('err.code'))).to.be.equal('ENOENT')
        expect(await state.doString(catchIt('err.errno'))).to.be.equal(-2)
        expect(await state.doString(catchIt('err.cause.message'))).to.be.equal('root')
    })

    it('should read an unknown field as nil, and nothing inherited', async () => {
        using state = await getState()
        setThrow(state)

        expect(await state.doString(catchIt('type(err.nope)'))).to.be.equal('nil')
        expect(await state.doString(catchIt('err.nope == nil'))).to.be.equal(true)
        expect(await state.doString(catchIt('err.constructor == nil and err.toString == nil'))).to.be.equal(true)
    })

    it('should be read-only', async () => {
        using state = await getState()
        setThrow(state)

        await expect(state.doString(catchIt('err.message = "rewritten"'))).to.eventually.be.rejected
    })

    it('should come back to JS as the error that was thrown', async () => {
        using state = await getState({ objects: 'copy' })
        const thrown = new Error('kaboom')
        setThrow(state, thrown)

        expect(await state.doString(catchIt('err'))).to.be.equal(thrown)
    })

    // Claiming every Error on type alone would swallow these.
    describe('should defer to an explicit wrapper', () => {
        const cases = [
            ['opaque', opaque, 'userdata', 'js_userdata'],
            ['proxy', proxy, 'userdata', 'Error: kaboom'],
            ['copy', copy, 'table', 'table:'],
        ]

        for (const [name, wrap, luaType, rendering] of cases) {
            it(name, async () => {
                using state = await getState()
                state.set('wrapped', wrap(new Error('kaboom')))

                expect(await state.doString('return type(wrapped)')).to.be.equal(luaType)
                expect(await state.doString('return tostring(wrapped)')).to.include(rendering)
            })
        }
    })

    it('should defer to a class defined for it', async () => {
        using state = await getState()
        class HttpError extends Error {
            constructor(status) {
                super(`status ${status}`)
                this.status = status
            }
            isClientError() {
                return this.status >= 400 && this.status < 500
            }
        }
        state.defineClass(HttpError)
        const thrown = new HttpError(404)
        setThrow(state, thrown)

        expect(await state.doString(catchIt('err:isClientError()'))).to.be.equal(true)
        await expect(state.doString('boom()')).to.eventually.be.rejected.then((error) => {
            expect(error.luaValue).to.be.equal(thrown)
        })
    })

    it('should expose an Error constructor to lua when injecting', async () => {
        using state = await getState()

        expect(await state.doString('return tostring(Error.create("made in lua"))')).to.be.equal('made in lua')
        expect(await state.doString('return Error.create("made in lua").message')).to.be.equal('made in lua')
    })

    it('should not expose the Error constructor when it is not injected', async () => {
        using state = await getState({ inject: ['Promise'] })

        expect(await state.doString('return type(Error)')).to.be.equal('nil')
    })
})

describe('Unrepresentable values', () => {
    it('getValue throws instead of returning an opaque handle', async () => {
        using state = await getState()
        const thread = state.newThread()
        thread.module.lua_newuserdatauv(thread.address, 4, 0)

        expect(() => thread.getValue(-1)).to.throw('has no JS representation')
    })

    it('the address is still reachable through getPointer', async () => {
        using state = await getState()
        const thread = state.newThread()
        thread.module.lua_newuserdatauv(thread.address, 4, 0)

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
            state.module.lua_pushnil(state.address)
        })

        expect(seen).to.have.lengthOf(1)
        expect(seen[0]).to.include('getTable: expected stack size')
    })
})
