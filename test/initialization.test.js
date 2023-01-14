const { LuaFactory } = require('..')

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
})
