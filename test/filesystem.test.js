import { expect } from 'chai'
import { getState, getLua } from './utils.js'

describe('Filesystem', () => {
    it('mount a file and require inside lua should succeed', async () => {
        const lua = await getLua()
        lua.mountFile('test.lua', 'answerToLifeTheUniverseAndEverything = 42')
        const state = lua.createState()

        await state.doString('require("test")')

        expect(state.get('answerToLifeTheUniverseAndEverything')).to.be.equal(42)
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
        using state = await getState()

        await expect(state.doString('require("nothing")')).to.eventually.be.rejectedWith(/module 'nothing' not found/)
    })

    it('mount a file and run it should succeed', async () => {
        const lua = await getLua()
        const state = lua.createState()

        lua.mountFile('init.lua', `return 42`)
        const value = await state.doFile('init.lua')

        expect(value).to.be.equal(42)
    })

    it('run a file which is not mounted should throw', async () => {
        using state = await getState()

        await expect(state.doFile('init.lua')).to.eventually.be.rejectedWith(/cannot open init\.lua/)
    })

    it('mount a file with binary content should succeed', async () => {
        const lua = await getLua()
        using state = lua.createState()

        lua.mountFile('binary.lua', new Uint8Array([114, 101, 116, 117, 114, 110, 32, 52, 50])) // "return 42"

        expect(await state.doString('return dofile("binary.lua")')).to.be.equal(42)
    })

    it('doFileSync should run a mounted file synchronously', async () => {
        const lua = await getLua()
        lua.mountFile('sync.lua', 'return 5 * 5')
        using state = lua.createState()

        expect(state.doFileSync('sync.lua')).to.be.equal(25)
    })

    it('filesystem should expose the shared emscripten FS', async () => {
        const lua = await getLua()
        lua.mountFile('fs-probe.lua', 'return 1')

        expect(lua.filesystem.analyzePath('/fs-probe.lua').exists).to.be.true
    })

    it('path should expose the emscripten path helpers', async () => {
        const lua = await getLua()

        expect(lua.path.dirname('/a/b/c.lua')).to.be.equal('/a/b')
        expect(lua.path.basename('/a/b/c.lua')).to.be.equal('c.lua')
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
