const { getEngine, getFactory } = require('./utils')
const { expect } = require('chai')

describe('Filesystem', () => {
    it('mount a file and require inside lua should succeed', async () => {
        const factory = getFactory()
        await factory.mountFile('test.lua', 'answerToLifeTheUniverseAndEverything = 42')
        const engine = await factory.createEngine()

        await engine.doString('require("test")')

        expect(engine.global.get('answerToLifeTheUniverseAndEverything')).to.be.equal(42)
    })

    it('mount a file in a complex directory and require inside lua should succeed', async () => {
        const factory = getFactory()
        await factory.mountFile('yolo/sofancy/test.lua', 'return 42')
        const engine = await factory.createEngine()

        // second parameter is path to module
        const [value] = await engine.doString('return require("yolo/sofancy/test")')

        expect(value).to.be.equal(42)
    })

    it('mount a init file and require the module inside lua should succeed', async () => {
        const factory = getFactory()
        await factory.mountFile('hello/init.lua', 'return 42')
        const engine = await factory.createEngine()

        // second parameter is path to module
        const [value] = await engine.doString('return require("hello")')

        expect(value).to.be.equal(42)
    })

    it('require a file which is not mounted should throw', async () => {
        const engine = await getEngine()

        await expect(engine.doString('require("nothing")')).to.eventually.be.rejected
    })

    it('mount a file and run it should succeed', async () => {
        const factory = getFactory()
        const engine = await factory.createEngine()

        await factory.mountFile('init.lua', `return 42`)
        const value = await engine.doFile('init.lua')

        expect(value).to.be.equal(42)
    })

    it('run a file which is not mounted should throw', async () => {
        const engine = await getEngine()

        await expect(engine.doFile('init.lua')).to.eventually.be.rejected
    })

    it('mount a file with a large content should succeed', async () => {
        const factory = getFactory()
        const engine = await factory.createEngine()

        const content = 'a'.repeat(1000000)
        await factory.mountFile('init.lua', `local a = "${content}" return a`)
        const value = await engine.doFile('init.lua')

        expect(value).to.be.equal(content)
    })
})
