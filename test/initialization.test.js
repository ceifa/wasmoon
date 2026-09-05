import { LUA_LIB_BITS, LuaRuntime } from '../dist/index.js'
import { expect } from 'chai'
import { getLua, getState } from './utils.js'

describe('Initialization', () => {
    it('create state should succeed', async () => {
        const lua = await LuaRuntime.load()
        using state = lua.createState()

        expect(state.isClosed()).to.be.false
        expect(state.address).to.be.greaterThan(0)
    })

    it('create multiple states should keep their globals independent', async () => {
        const lua = await LuaRuntime.load()
        using state1 = lua.createState()
        using state2 = lua.createState()

        await state1.doString('x = 10')
        await state2.doString('x = 20')

        expect(state1.address).to.not.be.equal(state2.address)
        expect(await state1.doString('return x')).to.be.equal(10)
        expect(await state2.doString('return x')).to.be.equal(20)
    })

    it('create state with options should apply them', async () => {
        const lua = await LuaRuntime.load()
        using state = lua.createState({
            objects: 'proxy',
            inject: true,
            libs: true,
            memory: { trace: true },
        })

        expect(state.memory.used).to.be.greaterThan(0)
        expect(await state.doString('return type(null)')).to.be.equal('userdata')
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

    it('an unknown library name is rejected, naming the valid ones', async () => {
        const lua = await LuaRuntime.load()

        expect(() => lua.createState({ libs: ['nope'] })).to.throw("unknown Lua library 'nope'")
        expect(() => lua.createState({ libs: ['nope'] })).to.throw(Object.keys(LUA_LIB_BITS).join(', '))
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

    // lua_close hands the lua_State back to the wasm allocator, so a call that gets through
    // afterwards is reading and writing memory something else may already own. These used to reach
    // the bindings: some trapped with `table index is out of bounds`, `get` returned whatever was
    // in the freed struct, and `call` reported the global as missing.
    describe('use after close', () => {
        // The guard is one check per operation and none per stack value, so these are every entry
        // point on the guarded side of that line. Split by shape rather than wrapped in a promise,
        // to hold each one to throwing the way it does when the state is open.
        const syncEntryPoints = {
            get: (state) => state.get('print'),
            set: (state) => state.set('x', 1),
            doStringSync: (state) => state.doStringSync('return 1'),
            doFileSync: (state) => state.doFileSync('script.lua'),
            call: (state) => state.call('print', 'hi'),
            getTable: (state) => state.getTable('_G', () => undefined),
            loadString: (state) => state.loadString('return 1'),
            loadFile: (state) => state.loadFile('script.lua'),
            newThread: (state) => state.newThread(),
            resetThread: (state) => state.resetThread(),
            resume: (state) => state.resume(),
            runSync: (state) => state.runSync(),
            setLimits: (state) => state.setLimits({ maxInstructions: 10 }),
            setDeadline: (state) => state.setDeadline(Date.now() + 10),
        }

        for (const [name, use] of Object.entries(syncEntryPoints)) {
            it(`${name} throws on a closed state instead of using freed memory`, async () => {
                using state = await getState()
                state.close()

                expect(() => use(state)).to.throw('the Lua state is closed')
            })
        }

        for (const name of ['doString', 'doFile']) {
            it(`${name} rejects on a closed state instead of using freed memory`, async () => {
                using state = await getState()
                state.close()

                await expect(state[name]('return 1')).to.eventually.be.rejectedWith('the Lua state is closed')
            })
        }

        it('a state closed by its runtime is refused the same way', async () => {
            const lua = await getLua()
            const state = lua.createState()
            lua.close()

            expect(() => state.doStringSync('return 1')).to.throw('the Lua state is closed')
        })

        it('a thread outlives neither the state nor the check', async () => {
            using state = await getState()
            const thread = state.newThread()
            state.close()

            expect(thread.isClosed()).to.be.true
            expect(() => thread.loadString('return 1')).to.throw('the Lua state is closed')
        })

        it('a state closed while a run is parked stops rather than resuming into freed memory', async () => {
            using state = await getState()
            state.set('sleep', (ms) => new Promise((resolve) => setTimeout(resolve, ms)))

            const running = state.doString('sleep(10):await() return 1')
            state.close()

            await expect(running).to.eventually.be.rejectedWith('the Lua state is closed')
        })
    })
})
