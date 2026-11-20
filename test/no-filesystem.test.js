import { expect } from 'chai'
import { LuaRuntime } from '../dist/index.js'

const NO_FILESYSTEM = /there is no filesystem with fs: 'none'/

describe('No filesystem', () => {
    let lua

    before(async () => {
        lua = await LuaRuntime.load({ fs: 'none' })
    })

    it('should run lua', async () => {
        using state = lua.createState()

        expect(await state.doString('return string.format("%d %.1f", 42, 1.5)')).to.be.equal('42 1.5')
    })

    it('should report the filesystem it was loaded with', () => {
        expect(lua.module.fs).to.be.equal('none')
    })

    it('opening a file should fail rather than hand back a handle', async () => {
        using state = lua.createState()

        const message = await state.doString('local file, message = io.open("test.lua", "w") return file == nil and message')

        expect(message).to.be.equal('test.lua: Function not implemented')
    })

    it('removing or renaming a file should fail rather than claim to have done it', async () => {
        using state = lua.createState()

        const results = await state.doString('return { os.remove("a") ~= nil, os.rename("a", "b") ~= nil }')

        expect(results).to.be.deep.equal([false, false])
    })

    it('require should still find a preloaded module', async () => {
        using state = lua.createState()

        const value = await state.doString('package.preload.answer = function() return 42 end return require("answer")')

        expect(value).to.be.equal(42)
    })

    it('doFile should throw', async () => {
        using state = lua.createState()

        await expect(state.doFile('init.lua')).to.eventually.be.rejectedWith(/cannot open init\.lua/)
    })

    it('the runtime file methods should throw', () => {
        expect(() => lua.writeFile('a.lua', 'return 1')).to.throw(NO_FILESYSTEM)
        expect(() => lua.exists('a.lua')).to.throw(NO_FILESYSTEM)
        expect(() => lua.filesystem).to.throw(NO_FILESYSTEM)
        expect(() => lua.path).to.throw(NO_FILESYSTEM)
        expect(() => lua.unmount('/scripts')).to.throw(NO_FILESYSTEM)
    })

    it('mounts should be refused', async () => {
        expect(() => lua.mount('/scripts', '.')).to.throw(/mounts belong to fs: 'memory'/)
        await expect(LuaRuntime.load({ fs: 'none', mounts: { '/scripts': '.' } })).to.eventually.be.rejectedWith(
            /mounts belong to fs: 'memory'/,
        )
    })

    it('stdio should go through the callbacks', async () => {
        const output = []
        const chunks = ['first\nsecond\n']
        const runtime = await LuaRuntime.load({
            fs: 'none',
            stdin: () => chunks.shift() ?? '',
            stdout: (content) => output.push(['stdout', content]),
            stderr: (content) => output.push(['stderr', content]),
        })
        using state = runtime.createState()

        const lines = await state.doString(`
            print("héllo", 1)
            io.stderr:write("oops\\n")
            io.write("no newline") io.flush()
            return { io.read("l"), io.read("l"), io.read("l") }
        `)
        await Promise.resolve()

        expect(lines).to.be.deep.equal(['first', 'second'])
        expect(output).to.be.deep.equal([
            ['stdout', 'héllo\t1'],
            ['stderr', 'oops'],
            ['stdout', 'no newline'],
        ])
    })

    it('stdin should be at its end when there is no callback', async () => {
        using state = lua.createState()

        expect(await state.doString('return io.read("l") == nil')).to.be.true
    })
})
