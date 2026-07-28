import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'chai'
import { LuaRuntime } from '../dist/index.js'

const createTempDir = () => {
    const dir = join(tmpdir(), `wasmoon-nodefs-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    return dir
}

describe('Node FS', () => {
    let tempDir

    beforeEach(() => {
        tempDir = createTempDir()
    })

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true })
    })

    it('read a host file should succeed', async () => {
        writeFileSync(join(tempDir, 'hello.txt'), 'hello world')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        const result = await state.doString(`
            local f = io.open("${join(tempDir, 'hello.txt').replace(/\\/g, '/')}", "r")
            local content = f:read("*a")
            f:close()
            return content
        `)

        expect(result).to.be.equal('hello world')
    })

    it('write a file to host should succeed', async () => {
        const filePath = join(tempDir, 'output.txt')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        await state.doString(`
            local f = io.open("${filePath.replace(/\\/g, '/')}", "w")
            f:write("written from lua")
            f:close()
        `)

        expect(readFileSync(filePath, 'utf8')).to.be.equal('written from lua')
    })

    it('append to a host file should succeed', async () => {
        const filePath = join(tempDir, 'append.txt')
        writeFileSync(filePath, 'first line\n')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        await state.doString(`
            local f = io.open("${filePath.replace(/\\/g, '/')}", "a")
            f:write("second line\\n")
            f:close()
        `)

        expect(readFileSync(filePath, 'utf8')).to.be.equal('first line\nsecond line\n')
    })

    it('read file line by line should succeed', async () => {
        writeFileSync(join(tempDir, 'lines.txt'), 'alpha\nbeta\ngamma\n')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        const result = await state.doString(`
            local lines = {}
            for line in io.lines("${join(tempDir, 'lines.txt').replace(/\\/g, '/')}") do
                lines[#lines + 1] = line
            end
            return table.concat(lines, ",")
        `)

        expect(result).to.be.equal('alpha,beta,gamma')
    })

    it('read binary file should succeed', async () => {
        const buf = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe])
        writeFileSync(join(tempDir, 'binary.dat'), buf)

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        const result = await state.doString(`
            local f = io.open("${join(tempDir, 'binary.dat').replace(/\\/g, '/')}", "rb")
            local data = f:read("*a")
            f:close()
            return #data
        `)

        expect(result).to.be.equal(5)
    })

    it('write and read back binary data should succeed', async () => {
        const filePath = join(tempDir, 'binout.dat')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        await state.doString(`
            local f = io.open("${filePath.replace(/\\/g, '/')}", "wb")
            f:write(string.char(72, 101, 108, 108, 111))
            f:close()
        `)

        expect(readFileSync(filePath, 'utf8')).to.be.equal('Hello')
    })

    it('check if file exists using io.open should succeed', async () => {
        writeFileSync(join(tempDir, 'exists.txt'), 'yes')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        const result = await state.doString(`
            local f = io.open("${join(tempDir, 'exists.txt').replace(/\\/g, '/')}", "r")
            local exists = f ~= nil
            if f then f:close() end

            local f2 = io.open("${join(tempDir, 'nope.txt').replace(/\\/g, '/')}", "r")
            local not_exists = f2 == nil
            if f2 then f2:close() end

            return exists and not_exists
        `)

        expect(result).to.be.true
    })

    it('read file size should succeed', async () => {
        writeFileSync(join(tempDir, 'sized.txt'), 'abcdefghij')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        const result = await state.doString(`
            local f = io.open("${join(tempDir, 'sized.txt').replace(/\\/g, '/')}", "r")
            local size = f:seek("end")
            f:close()
            return size
        `)

        expect(result).to.be.equal(10)
    })

    it('seek within a file should succeed', async () => {
        writeFileSync(join(tempDir, 'seek.txt'), 'abcdefghij')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        const result = await state.doString(`
            local f = io.open("${join(tempDir, 'seek.txt').replace(/\\/g, '/')}", "r")
            f:seek("set", 3)
            local chunk = f:read(4)
            f:close()
            return chunk
        `)

        expect(result).to.be.equal('defg')
    })

    it('doFile from host filesystem should succeed', async () => {
        writeFileSync(join(tempDir, 'script.lua'), 'return 7 * 6')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        const result = await state.doFile(join(tempDir, 'script.lua').replace(/\\/g, '/'))

        expect(result).to.be.equal(42)
    })

    it('require a host lua file should succeed', async () => {
        const luaDir = join(tempDir, 'lualibs')
        mkdirSync(luaDir, { recursive: true })
        writeFileSync(join(luaDir, 'mymod.lua'), 'local M = {}; M.value = 99; return M')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState({ inject: true })
        const result = await state.doString(`
            package.path = "${luaDir.replace(/\\/g, '/')}/?.lua;" .. package.path
            local m = require("mymod")
            return m.value
        `)

        expect(result).to.be.equal(99)
    })

    it('read from nested directories should succeed', async () => {
        const nested = join(tempDir, 'a', 'b', 'c')
        mkdirSync(nested, { recursive: true })
        writeFileSync(join(nested, 'deep.txt'), 'deep content')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        const result = await state.doString(`
            local f = io.open("${join(nested, 'deep.txt').replace(/\\/g, '/')}", "r")
            local content = f:read("*a")
            f:close()
            return content
        `)

        expect(result).to.be.equal('deep content')
    })

    it('create directory from lua with os.execute should succeed', async () => {
        const newDir = join(tempDir, 'newdir')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        await state.doString(`
            os.execute("mkdir -p '${newDir.replace(/\\/g, '/')}'")
        `)

        expect(existsSync(newDir)).to.be.true
    })

    it('remove a host file from lua with os.remove should succeed', async () => {
        const filePath = join(tempDir, 'removeme.txt')
        writeFileSync(filePath, 'to be deleted')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        const result = await state.doString(`
            return os.remove("${filePath.replace(/\\/g, '/')}")
        `)

        expect(result).to.be.true
        expect(existsSync(filePath)).to.be.false
    })

    it('rename a host file from lua with os.rename should succeed', async () => {
        const oldPath = join(tempDir, 'old.txt')
        const newPath = join(tempDir, 'new.txt')
        writeFileSync(oldPath, 'rename me')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        const result = await state.doString(`
            return os.rename("${oldPath.replace(/\\/g, '/')}", "${newPath.replace(/\\/g, '/')}")
        `)

        expect(result).to.be.true
        expect(existsSync(oldPath)).to.be.false
        expect(readFileSync(newPath, 'utf8')).to.be.equal('rename me')
    })

    it('doFile from cwd-relative path should succeed', async () => {
        // NODEFS sets cwd to process.cwd(), so relative doFile should work
        const lua = await LuaRuntime.load({ fs: 'node' })
        lua.mountFile('cwd_test.lua', 'return "from cwd"')
        try {
            const state = lua.createState()
            const result = await state.doFile('cwd_test.lua')

            expect(result).to.be.equal('from cwd')
        } finally {
            rmSync('cwd_test.lua', { force: true })
        }
    })

    it('write large file should succeed', async () => {
        const filePath = join(tempDir, 'large.txt')
        const lineCount = 10000

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        await state.doString(`
            local f = io.open("${filePath.replace(/\\/g, '/')}", "w")
            for i = 1, ${lineCount} do
                f:write("line " .. i .. "\\n")
            end
            f:close()
        `)

        const content = readFileSync(filePath, 'utf8')
        const lines = content.trimEnd().split('\n')
        expect(lines.length).to.be.equal(lineCount)
        expect(lines[0]).to.be.equal('line 1')
        expect(lines[lineCount - 1]).to.be.equal(`line ${lineCount}`)
    })

    it('overwrite existing file should succeed', async () => {
        const filePath = join(tempDir, 'overwrite.txt')
        writeFileSync(filePath, 'original content')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        await state.doString(`
            local f = io.open("${filePath.replace(/\\/g, '/')}", "w")
            f:write("new content")
            f:close()
        `)

        expect(readFileSync(filePath, 'utf8')).to.be.equal('new content')
    })

    it('read UTF-8 content should succeed', async () => {
        const content = 'héllo wörld 日本語 🌍'
        writeFileSync(join(tempDir, 'utf8.txt'), content)

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        const result = await state.doString(`
            local f = io.open("${join(tempDir, 'utf8.txt').replace(/\\/g, '/')}", "r")
            local data = f:read("*a")
            f:close()
            return data
        `)

        expect(result).to.be.equal(content)
    })

    it('write UTF-8 content should succeed', async () => {
        const filePath = join(tempDir, 'utf8out.txt')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        await state.doString(`
            local f = io.open("${filePath.replace(/\\/g, '/')}", "w")
            f:write("café ñ 中文")
            f:close()
        `)

        expect(readFileSync(filePath, 'utf8')).to.be.equal('café ñ 中文')
    })

    it('read empty file should succeed', async () => {
        writeFileSync(join(tempDir, 'empty.txt'), '')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        const result = await state.doString(`
            local f = io.open("${join(tempDir, 'empty.txt').replace(/\\/g, '/')}", "r")
            local data = f:read("*a")
            f:close()
            return #data
        `)

        expect(result).to.be.equal(0)
    })

    it('open non-existent file for reading should return nil', async () => {
        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        const result = await state.doString(`
            local f, err = io.open("${join(tempDir, 'nonexistent.txt').replace(/\\/g, '/')}", "r")
            return f == nil
        `)

        expect(result).to.be.true
    })

    it('io.tmpfile should succeed', async () => {
        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
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

    it('multiple states sharing the same NODEFS should succeed', async () => {
        const filePath = join(tempDir, 'shared.txt')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state1 = lua.createState()
        const state2 = lua.createState()

        await state1.doString(`
            local f = io.open("${filePath.replace(/\\/g, '/')}", "w")
            f:write("from state1")
            f:close()
        `)

        const result = await state2.doString(`
            local f = io.open("${filePath.replace(/\\/g, '/')}", "r")
            local data = f:read("*a")
            f:close()
            return data
        `)

        expect(result).to.be.equal('from state1')
    })

    it('read number from file should succeed', async () => {
        writeFileSync(join(tempDir, 'numbers.txt'), '42\n3.14\n100')

        const lua = await LuaRuntime.load({ fs: 'node' })
        const state = lua.createState()
        const result = await state.doString(`
            local f = io.open("${join(tempDir, 'numbers.txt').replace(/\\/g, '/')}", "r")
            local n1 = f:read("*n")
            local n2 = f:read("*n")
            local n3 = f:read("*n")
            f:close()
            return n1 + n2 + n3
        `)

        expect(result).to.be.closeTo(145.14, 0.001)
    })
})
