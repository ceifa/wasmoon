import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'chai'
import { LuaRuntime } from '../dist/index.js'
import { luaPath, readFileFromLua, useTempDirs } from './utils.js'

describe('Host filesystem', () => {
    // fs: 'host' has no working directory of its own -- chdir moves the Node process, so a test that
    // moves into a temp directory has to come back. Registered before useTempDirs so it runs before
    // the directory the process may be sitting in is removed.
    const originalCwd = process.cwd()
    afterEach(() => process.chdir(originalCwd))

    const createTempDir = useTempDirs('host')
    let tempDir
    let lua
    let state

    beforeEach(async () => {
        tempDir = createTempDir()
        lua = await LuaRuntime.load({ fs: 'host' })
        state = lua.createState()
    })

    afterEach(() => lua.close())

    /** Absolute host path of `name` inside the temp directory, as a Lua string literal. */
    const at = (...name) => luaPath(join(tempDir, ...name))

    it('read a host file should succeed', () => {
        writeFileSync(join(tempDir, 'hello.txt'), 'hello world')

        expect(readFileFromLua(state, at('hello.txt'))).to.be.equal('hello world')
    })

    it('write a file to host should succeed', async () => {
        await state.doString(`
            local f = io.open("${at('output.txt')}", "w")
            f:write("written from lua")
            f:close()
        `)

        expect(readFileSync(join(tempDir, 'output.txt'), 'utf8')).to.be.equal('written from lua')
    })

    it('append to a host file should succeed', async () => {
        writeFileSync(join(tempDir, 'append.txt'), 'first line\n')

        await state.doString(`
            local f = io.open("${at('append.txt')}", "a")
            f:write("second line\\n")
            f:close()
        `)

        expect(readFileSync(join(tempDir, 'append.txt'), 'utf8')).to.be.equal('first line\nsecond line\n')
    })

    it('read file line by line should succeed', async () => {
        writeFileSync(join(tempDir, 'lines.txt'), 'alpha\nbeta\ngamma\n')

        const result = await state.doString(`
            local lines = {}
            for line in io.lines("${at('lines.txt')}") do
                lines[#lines + 1] = line
            end
            return table.concat(lines, ",")
        `)

        expect(result).to.be.equal('alpha,beta,gamma')
    })

    it('read binary file should succeed', async () => {
        writeFileSync(join(tempDir, 'binary.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]))

        const result = await state.doString(`
            local f = io.open("${at('binary.dat')}", "rb")
            local data = f:read("*a")
            f:close()
            return #data
        `)

        expect(result).to.be.equal(5)
    })

    it('write and read back binary data should succeed', async () => {
        await state.doString(`
            local f = io.open("${at('binout.dat')}", "wb")
            f:write(string.char(72, 101, 108, 108, 111))
            f:close()
        `)

        expect(readFileSync(join(tempDir, 'binout.dat'), 'utf8')).to.be.equal('Hello')
    })

    it('check if file exists using io.open should succeed', async () => {
        writeFileSync(join(tempDir, 'exists.txt'), 'yes')

        const result = await state.doString(`
            local f = io.open("${at('exists.txt')}", "r")
            local exists = f ~= nil
            if f then f:close() end

            local f2 = io.open("${at('nope.txt')}", "r")
            local not_exists = f2 == nil
            if f2 then f2:close() end

            return exists and not_exists
        `)

        expect(result).to.be.true
    })

    it('read file size should succeed', async () => {
        writeFileSync(join(tempDir, 'sized.txt'), 'abcdefghij')

        const result = await state.doString(`
            local f = io.open("${at('sized.txt')}", "r")
            local size = f:seek("end")
            f:close()
            return size
        `)

        expect(result).to.be.equal(10)
    })

    it('seek within a file should succeed', async () => {
        writeFileSync(join(tempDir, 'seek.txt'), 'abcdefghij')

        const result = await state.doString(`
            local f = io.open("${at('seek.txt')}", "r")
            f:seek("set", 3)
            local chunk = f:read(4)
            f:close()
            return chunk
        `)

        expect(result).to.be.equal('defg')
    })

    it('doFile from host filesystem should succeed', async () => {
        writeFileSync(join(tempDir, 'script.lua'), 'return 7 * 6')

        expect(await state.doFile(at('script.lua'))).to.be.equal(42)
    })

    it('require a host lua file should succeed', async () => {
        const luaDir = join(tempDir, 'lualibs')
        mkdirSync(luaDir, { recursive: true })
        writeFileSync(join(luaDir, 'mymod.lua'), 'local M = {}; M.value = 99; return M')

        using injected = lua.createState({ inject: true })
        const result = await injected.doString(`
            package.path = "${at('lualibs')}/?.lua;" .. package.path
            local m = require("mymod")
            return m.value
        `)

        expect(result).to.be.equal(99)
    })

    it('read from nested directories should succeed', () => {
        const nested = join(tempDir, 'a', 'b', 'c')
        mkdirSync(nested, { recursive: true })
        writeFileSync(join(nested, 'deep.txt'), 'deep content')

        expect(readFileFromLua(state, join(nested, 'deep.txt'))).to.be.equal('deep content')
    })

    it('read through a host symlink should succeed', () => {
        // A mirror of the host namespace resolves an absolute symlink target against itself rather
        // than against the host, so this only works when the filesystem really is the host's.
        writeFileSync(join(tempDir, 'target.txt'), 'behind the link')
        symlinkSync(join(tempDir, 'target.txt'), join(tempDir, 'absolute.link'))
        symlinkSync('target.txt', join(tempDir, 'relative.link'))

        expect(readFileFromLua(state, at('absolute.link'))).to.be.equal('behind the link')
        expect(readFileFromLua(state, at('relative.link'))).to.be.equal('behind the link')
    })

    it('create directory from lua with os.execute should succeed', async () => {
        await state.doString(`os.execute("mkdir -p '${at('newdir')}'")`)

        expect(existsSync(join(tempDir, 'newdir'))).to.be.true
    })

    it('remove a host file from lua with os.remove should succeed', async () => {
        writeFileSync(join(tempDir, 'removeme.txt'), 'to be deleted')

        expect(await state.doString(`return os.remove("${at('removeme.txt')}")`)).to.be.true
        expect(existsSync(join(tempDir, 'removeme.txt'))).to.be.false
    })

    it('rename a host file from lua with os.rename should succeed', async () => {
        writeFileSync(join(tempDir, 'old.txt'), 'rename me')

        const result = await state.doString(`return os.rename("${at('old.txt')}", "${at('new.txt')}")`)

        expect(result).to.be.true
        expect(existsSync(join(tempDir, 'old.txt'))).to.be.false
        expect(readFileSync(join(tempDir, 'new.txt'), 'utf8')).to.be.equal('rename me')
    })

    it('the working directory should be the host process one', () => {
        expect(lua.cwd()).to.be.equal(process.cwd())
    })

    it('a relative path should resolve against the host working directory', async () => {
        writeFileSync(join(tempDir, 'relative.lua'), 'return "from cwd"')

        lua.chdir(tempDir)

        // realpath, because the temp directory sits behind a symlink on macOS and the working
        // directory is always the resolved one.
        expect(lua.cwd()).to.be.equal(realpathSync(tempDir))
        // chdir moved the process, so Node agrees on where "here" is.
        expect(process.cwd()).to.be.equal(realpathSync(tempDir))
        expect(await state.doFile('relative.lua')).to.be.equal('from cwd')
    })

    it('writeFile should write to the real filesystem', async () => {
        lua.writeFile(at('nested', 'written.lua'), 'return "written"')

        expect(readFileSync(join(tempDir, 'nested', 'written.lua'), 'utf8')).to.be.equal('return "written"')
        expect(await state.doFile(at('nested', 'written.lua'))).to.be.equal('written')
    })

    it('write large file should succeed', async () => {
        const lineCount = 10000

        await state.doString(`
            local f = io.open("${at('large.txt')}", "w")
            for i = 1, ${lineCount} do
                f:write("line " .. i .. "\\n")
            end
            f:close()
        `)

        const lines = readFileSync(join(tempDir, 'large.txt'), 'utf8').trimEnd().split('\n')
        expect(lines.length).to.be.equal(lineCount)
        expect(lines[0]).to.be.equal('line 1')
        expect(lines[lineCount - 1]).to.be.equal(`line ${lineCount}`)
    })

    it('overwrite existing file should succeed', async () => {
        writeFileSync(join(tempDir, 'overwrite.txt'), 'original content')

        await state.doString(`
            local f = io.open("${at('overwrite.txt')}", "w")
            f:write("new content")
            f:close()
        `)

        expect(readFileSync(join(tempDir, 'overwrite.txt'), 'utf8')).to.be.equal('new content')
    })

    it('read UTF-8 content should succeed', () => {
        const content = 'héllo wörld 日本語 🌍'
        writeFileSync(join(tempDir, 'utf8.txt'), content)

        expect(readFileFromLua(state, at('utf8.txt'))).to.be.equal(content)
    })

    it('write UTF-8 content should succeed', async () => {
        await state.doString(`
            local f = io.open("${at('utf8out.txt')}", "w")
            f:write("café ñ 中文")
            f:close()
        `)

        expect(readFileSync(join(tempDir, 'utf8out.txt'), 'utf8')).to.be.equal('café ñ 中文')
    })

    it('read empty file should succeed', async () => {
        writeFileSync(join(tempDir, 'empty.txt'), '')

        const result = await state.doString(`
            local f = io.open("${at('empty.txt')}", "r")
            local data = f:read("*a")
            f:close()
            return #data
        `)

        expect(result).to.be.equal(0)
    })

    it('open non-existent file for reading should return nil and a message', async () => {
        const result = await state.doString(`
            local f, err = io.open("${at('nonexistent.txt')}", "r")
            return f == nil and type(err) == "string" and #err > 0
        `)

        expect(result).to.be.true
    })

    it('io.tmpfile should succeed', async () => {
        const result = await state.doString(`
            local f = io.tmpfile()
            f:write("temp data")
            f:seek("set")
            local data = f:read("*a")
            f:close()
            return data
        `)

        expect(result).to.be.equal('temp data')
    })

    it('multiple states sharing the same filesystem should succeed', async () => {
        using other = lua.createState()

        await state.doString(`
            local f = io.open("${at('shared.txt')}", "w")
            f:write("from state1")
            f:close()
        `)

        expect(readFileFromLua(other, at('shared.txt'))).to.be.equal('from state1')
    })

    it('read number from file should succeed', async () => {
        writeFileSync(join(tempDir, 'numbers.txt'), '42\n3.14\n100')

        const result = await state.doString(`
            local f = io.open("${at('numbers.txt')}", "r")
            local n1 = f:read("*n")
            local n2 = f:read("*n")
            local n3 = f:read("*n")
            f:close()
            return n1 + n2 + n3
        `)

        expect(result).to.be.closeTo(145.14, 0.001)
    })

    it('mounts should be rejected, since every host path is already reachable', async () => {
        await expect(LuaRuntime.load({ fs: 'host', mounts: { '/scripts': tempDir } })).to.eventually.be.rejectedWith(
            /mounts belong to fs: 'memory'/,
        )
        expect(() => lua.mount('/scripts', tempDir)).to.throw(/mounts belong to fs: 'memory'/)
    })
})
