import { LuaFactory } from '../dist/index.js'
import { expect } from 'chai'

describe('Initialization', () => {
    it('create engine should succeed', async () => {
        await new LuaFactory().createEngine()
    })

    it('create engine with options should succeed', async () => {
        await new LuaFactory().createEngine({
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
        const engine = await new LuaFactory({ env }).createEngine()

        const value = await engine.doString('return os.getenv("ENV_TEST")')

        expect(value).to.be.equal(env.ENV_TEST)
    })
})
