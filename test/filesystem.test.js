import { expect } from 'chai'
import { getState, getLua } from './utils.js'

describe('Filesystem', () => {
    it('mount a file and require inside lua should succeed', async () => {
        const lua = await getLua()
        lua.mountFile('test.lua', 'answerToLifeTheUniverseAndEverything = 42')
        const state = lua.createState()

        await state.doString('require("test")')

        expect(state.global.get('answerToLifeTheUniverseAndEverything')).to.be.equal(42)
    })

    it('mount a file in a complex directory and require inside lua should succeed', async () => {
        const lua = await getLua()
        lua.mountFile('yolo/sofancy/test.lua', 'return 42')
        const state = lua.createState()

        const value = await state.doString('return require("yolo/sofancy/test")')

        expect(value).to.be.equal(42)
    })

    it('mount a init file and require the module inside lua should succeed', async () => {
        const lua = await getLua()
        lua.mountFile('hello/init.lua', 'return 42')
        const state = lua.createState()

        const value = await state.doString('return require("hello")')

        expect(value).to.be.equal(42)
    })

    it('require a file which is not mounted should throw', async () => {
        const state = await getState()

        await expect(state.doString('require("nothing")')).to.eventually.be.rejected
    })

    it('mount a file and run it should succeed', async () => {
        const lua = await getLua()
        const state = lua.createState()

        lua.mountFile('init.lua', `return 42`)
        const value = await state.doFile('init.lua')

        expect(value).to.be.equal(42)
    })

    it('run a file which is not mounted should throw', async () => {
        const state = await getState()

        await expect(state.doFile('init.lua')).to.eventually.be.rejected
    })

    it('mount a file with a large content should succeed', async () => {
        const lua = await getLua()
        const state = lua.createState()

        const content = 'a'.repeat(1000000)
        lua.mountFile('init.lua', `local a = "${content}" return a`)
        const value = await state.doFile('init.lua')

        expect(value).to.be.equal(content)
    })
})
