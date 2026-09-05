import { expect } from 'chai'
import { getState, getLua } from './utils.js'

describe('Filesystem', () => {
    it('write a file and require inside lua should succeed', async () => {
        const lua = await getLua()
        lua.writeFile('test.lua', 'answerToLifeTheUniverseAndEverything = 42')
        const state = lua.createState()

        await state.doString('require("test")')

        expect(state.get('answerToLifeTheUniverseAndEverything')).to.be.equal(42)
    })

    it('write a file in a complex directory and require inside lua should succeed', async () => {
        const lua = await getLua()
        lua.writeFile('yolo/sofancy/test.lua', 'return 42')
        const state = lua.createState()

        const value = await state.doString('return require("yolo/sofancy/test")')

        expect(value).to.be.equal(42)
    })

    it('write a init file and require the module inside lua should succeed', async () => {
        const lua = await getLua()
        lua.writeFile('hello/init.lua', 'return 42')
        const state = lua.createState()

        const value = await state.doString('return require("hello")')

        expect(value).to.be.equal(42)
    })

    it('require a file which was not written should throw', async () => {
        using state = await getState()

        await expect(state.doString('require("nothing")')).to.eventually.be.rejectedWith(/module 'nothing' not found/)
    })

    it('write a file and run it should succeed', async () => {
        const lua = await getLua()
        const state = lua.createState()

        lua.writeFile('init.lua', `return 42`)
        const value = await state.doFile('init.lua')

        expect(value).to.be.equal(42)
    })

    it('run a file which was not written should throw', async () => {
        using state = await getState()

        await expect(state.doFile('init.lua')).to.eventually.be.rejectedWith(/cannot open init\.lua/)
    })

    it('write a file with binary content should succeed', async () => {
        const lua = await getLua()
        using state = lua.createState()

        lua.writeFile('binary.lua', new Uint8Array([114, 101, 116, 117, 114, 110, 32, 52, 50])) // "return 42"

        expect(await state.doString('return dofile("binary.lua")')).to.be.equal(42)
    })

    it('doFileSync should run a written file synchronously', async () => {
        const lua = await getLua()
        lua.writeFile('sync.lua', 'return 5 * 5')
        using state = lua.createState()

        expect(state.doFileSync('sync.lua')).to.be.equal(25)
    })

    it('the default filesystem should be the in-memory one', async () => {
        const lua = await getLua()

        expect(lua.module.fs).to.be.equal('memory')
        // Nothing of the host is reachable, and relative paths resolve from the root.
        expect(lua.cwd()).to.be.equal('/')
    })

    it('readFile should return what lua wrote', async () => {
        const lua = await getLua()
        using state = lua.createState()

        await state.doString(`
            local f = io.open("/written.txt", "w")
            f:write("from lua")
            f:close()
        `)

        expect(lua.readTextFile('/written.txt')).to.be.equal('from lua')
        expect(lua.readFile('/written.txt')).to.be.deep.equal(new Uint8Array([102, 114, 111, 109, 32, 108, 117, 97]))
    })

    it('exists should report both a written and a missing file', async () => {
        const lua = await getLua()
        lua.writeFile('/present.lua', 'return 1')

        expect(lua.exists('/present.lua')).to.be.true
        expect(lua.exists('/absent.lua')).to.be.false
    })

    it('chdir should move where relative paths resolve from', async () => {
        const lua = await getLua()
        lua.writeFile('/somewhere/mod.lua', 'return "found"')
        using state = lua.createState()

        lua.chdir('/somewhere')

        expect(lua.cwd()).to.be.equal('/somewhere')
        expect(await state.doFile('mod.lua')).to.be.equal('found')
    })

    it('filesystem should expose the shared emscripten FS', async () => {
        const lua = await getLua()
        lua.writeFile('fs-probe.lua', 'return 1')

        expect(lua.filesystem.analyzePath('/fs-probe.lua').exists).to.be.true
    })

    it('path should expose the emscripten path helpers', async () => {
        const lua = await getLua()

        expect(lua.path.dirname('/a/b/c.lua')).to.be.equal('/a/b')
        expect(lua.path.basename('/a/b/c.lua')).to.be.equal('c.lua')
    })

    it('write a file with a large content should succeed', async () => {
        const lua = await getLua()
        const state = lua.createState()

        const content = 'a'.repeat(1000000)
        lua.writeFile('init.lua', `local a = "${content}" return a`)
        const value = await state.doFile('init.lua')

        expect(value).to.be.equal(content)
    })
})
