import { Lua } from '../dist/index.js'
import { expect } from 'chai'

describe('Initialization', () => {
    it('create state should succeed', async () => {
        const lua = await Lua.load()
        lua.createState()
    })

    it('create multiple states should succeed', async () => {
        const lua = await Lua.load()
        const state1 = lua.createState()
        const state2 = lua.createState()

        expect(state1.global.address).to.not.be.equal(state2.global.address)
    })

    it('create state with options should succeed', async () => {
        const lua = await Lua.load()
        lua.createState({
            enableProxy: true,
            injectObjects: true,
            openStandardLibs: true,
            traceAllocations: true,
        })
    })

    it('create with environment variables should succeed', async () => {
        const env = {
            ENV_TEST: 'test',
        }
        const lua = await Lua.load({ env })
        const state = lua.createState()

        const value = await state.doString('return os.getenv("ENV_TEST")')

        expect(value).to.be.equal(env.ENV_TEST)
    })
})
