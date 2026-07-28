import { LuaRuntime, LuaError } from '../dist/index.js'
import { expect } from 'chai'
import { getState } from './utils.js'

describe('LuaError', () => {
    it('keeps the raised value, message and traceback apart', async () => {
        const state = await getState()

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
        const state = await getState()
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

describe('Unrepresentable values', () => {
    it('getValue throws instead of returning an opaque handle', async () => {
        const state = await getState()
        const thread = state.newThread()
        thread.lua.lua_newuserdatauv(thread.address, 4, 0)

        expect(() => thread.getValue(-1)).to.throw('has no JS representation')
    })

    it('the address is still reachable through getPointer', async () => {
        const state = await getState()
        const thread = state.newThread()
        thread.lua.lua_newuserdatauv(thread.address, 4, 0)

        expect(Number(thread.getPointer(-1))).to.be.greaterThan(0)
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
