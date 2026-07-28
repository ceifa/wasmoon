import { LuaRuntime } from '../dist/index.js'
import { expect } from 'chai'

describe('Initialization', () => {
    it('create state should succeed', async () => {
        const lua = await LuaRuntime.load()
        lua.createState()
    })

    it('create multiple states should succeed', async () => {
        const lua = await LuaRuntime.load()
        const state1 = lua.createState()
        const state2 = lua.createState()

        expect(state1.address).to.not.be.equal(state2.address)
    })

    it('create state with options should succeed', async () => {
        const lua = await LuaRuntime.load()
        lua.createState({
            objects: 'proxy',
            inject: true,
            libs: true,
            memory: { trace: true },
        })
    })

    it('create with environment variables should succeed', async () => {
        const env = {
            ENV_TEST: 'test',
        }
        const lua = await LuaRuntime.load({ env })
        const state = lua.createState()

        const value = await state.doString('return os.getenv("ENV_TEST")')

        expect(value).to.be.equal(env.ENV_TEST)
    })
})

describe('Standard libraries', () => {
    // LUA_LIB_BITS is transcribed by hand from lualib.h, so each bit is checked against the
    // global its library installs. A reordering on a Lua version bump fails here.
    const cases = [
        ['base', 'print'],
        ['package', 'require'],
        ['coroutine', 'coroutine'],
        ['debug', 'debug'],
        ['io', 'io'],
        ['math', 'math'],
        ['os', 'os'],
        ['string', 'string'],
        ['table', 'table'],
        ['utf8', 'utf8'],
    ]

    for (const [lib, global] of cases) {
        it(`libs: ['${lib}'] installs ${global} and nothing else`, async () => {
            const lua = await LuaRuntime.load()
            // base comes along so `type` exists; io holds FILE* userdata with no JS
            // representation, so presence is asserted from Lua rather than marshalled.
            using state = lua.createState({ libs: lib === 'base' ? ['base'] : ['base', lib] })
            const typeOf = (name) => state.doStringSync(`return type(${name})`)

            expect(typeOf(global), `${lib} should install ${global}`).to.not.be.equal('nil')

            for (const [otherLib, otherGlobal] of cases) {
                if (otherLib === lib || otherLib === 'base' || otherGlobal === global) {
                    continue
                }
                expect(typeOf(otherGlobal), `${lib} should not install ${otherGlobal}`).to.be.equal('nil')
            }
        })
    }

    it('libs: false leaves the state empty', async () => {
        const lua = await LuaRuntime.load()
        using state = lua.createState({ libs: false })

        // Without the base library there is no `type` either, so this reads the globals directly.
        expect(state.get('print')).to.be.null
        expect(state.get('tostring')).to.be.null
    })

    it('libs defaults to all of them', async () => {
        const lua = await LuaRuntime.load()
        using state = lua.createState()

        for (const [, global] of cases) {
            expect(state.doStringSync(`return type(${global})`), global).to.not.be.equal('nil')
        }
    })

    it('an unknown library name is rejected', async () => {
        const lua = await LuaRuntime.load()

        expect(() => lua.createState({ libs: ['nope'] })).to.throw('unknown Lua library: nope')
    })
})

describe('Disposal', () => {
    it('using closes the state at the end of the block', async () => {
        const lua = await LuaRuntime.load()
        let escaped
        {
            using state = lua.createState()
            escaped = state
            expect(state.isClosed()).to.be.false
        }

        expect(escaped.isClosed()).to.be.true
    })

    it('closing the runtime closes every state it created', async () => {
        const lua = await LuaRuntime.load()
        const first = lua.createState()
        const second = lua.createState()

        lua.close()

        expect(first.isClosed()).to.be.true
        expect(second.isClosed()).to.be.true
    })

    it('a closed state is released by the runtime that made it', async () => {
        const lua = await LuaRuntime.load()

        // Without this the Set grows for the runtime's lifetime, which a create/close loop hits.
        for (let index = 0; index < 100; index++) {
            lua.createState().close()
        }
        const retained = Object.values(lua).find((value) => value instanceof Set)

        expect(retained.size).to.be.equal(0)
    })

    it('await using disposes the runtime', async () => {
        let escaped
        {
            await using lua = await LuaRuntime.load()
            escaped = lua.createState()
        }

        expect(escaped.isClosed()).to.be.true
    })
})
