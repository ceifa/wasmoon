import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect } from 'chai'
import { Lua } from '../dist/index.js'

describe('Node environment', () => {
    it('load Lua engine in node should succeed', async () => {
        const lua = await Lua.load()
        const state = lua.createState()
        const result = await state.doString('return 1 + 1')
        expect(result).to.be.equal(2)
    })

    it('access environment variables should succeed', async () => {
        const env = { MY_TEST_VAR: 'hello_from_node' }
        const lua = await Lua.load({ env })
        const state = lua.createState()
        const result = await state.doString('return os.getenv("MY_TEST_VAR")')
        expect(result).to.be.equal('hello_from_node')
    })

    it('custom stdout should succeed', async () => {
        const output = []
        const lua = await Lua.load({
            stdout: (content) => output.push(content),
        })
        const state = lua.createState()
        await state.doString('print("hello from node")')
        expect(output.join('')).to.include('hello from node')
    })

    it('custom stderr should succeed', async () => {
        const errors = []
        const lua = await Lua.load({
            stderr: (content) => errors.push(content),
        })
        const state = lua.createState()
        await state.doString('io.stderr:write("error output\\n")')
        expect(errors.join('')).to.include('error output')
    })

    it('mount file and require in node should succeed', async () => {
        const lua = await Lua.load()
        lua.mountFile('nodetest.lua', 'return { value = 99 }')
        const state = lua.createState({ injectObjects: true })
        const result = await state.doString('local m = require("nodetest"); return m.value')
        expect(result).to.be.equal(99)
    })

    it('mount file with binary content should succeed', async () => {
        const lua = await Lua.load()
        const content = new Uint8Array([114, 101, 116, 117, 114, 110, 32, 52, 50]) // "return 42"
        lua.mountFile('binary.lua', content)
        const state = lua.createState()
        const result = await state.doString('return dofile("binary.lua")')
        expect(result).to.be.equal(42)
    })

    it('mount file in nested directories should succeed', async () => {
        const lua = await Lua.load()
        lua.mountFile('a/b/c/deep.lua', 'return "deep"')
        const state = lua.createState()
        const result = await state.doString('return require("a/b/c/deep")')
        expect(result).to.be.equal('deep')
    })

    it('create multiple independent states should succeed', async () => {
        const lua = await Lua.load()
        const state1 = lua.createState()
        const state2 = lua.createState()

        await state1.doString('x = 10')
        await state2.doString('x = 20')

        const val1 = await state1.doString('return x')
        const val2 = await state2.doString('return x')

        expect(val1).to.be.equal(10)
        expect(val2).to.be.equal(20)
    })

    it('pass complex JS objects to Lua should succeed', async () => {
        const state = (await Lua.load()).createState({ injectObjects: true })
        state.global.set('data', {
            name: 'test',
            nested: { value: 42 },
            items: [1, 2, 3],
        })
        const result = await state.doString('return data.nested.value')
        expect(result).to.be.equal(42)
    })

    it('call JS async functions from Lua should succeed', async () => {
        const state = (await Lua.load()).createState({ injectObjects: true })
        state.global.set('fetchData', async () => {
            return 'async result'
        })
        const result = await state.doString('return fetchData():await()')
        expect(result).to.be.equal('async result')
    })

    it('use NODEFS to read host files should succeed', async () => {
        const tempDir = join(tmpdir(), `wasmoon-test-${Date.now()}`)
        mkdirSync(tempDir, { recursive: true })
        const testFile = join(tempDir, 'test.txt')
        writeFileSync(testFile, 'hello from host')

        try {
            const lua = await Lua.load({ fs: 'node' })
            const state = lua.createState()
            const result = await state.doString(`
                local f = io.open("${testFile.replace(/\\/g, '/')}", "r")
                local content = f:read("*a")
                f:close()
                return content
            `)
            expect(result).to.be.equal('hello from host')
        } finally {
            rmSync(tempDir, { recursive: true, force: true })
        }
    })

    it('use NODEFS to write and read back files should succeed', async () => {
        const tempDir = join(tmpdir(), `wasmoon-test-${Date.now()}`)
        mkdirSync(tempDir, { recursive: true })
        const testFile = join(tempDir, 'output.txt')

        try {
            const lua = await Lua.load({ fs: 'node' })
            const state = lua.createState()
            await state.doString(`
                local f = io.open("${testFile.replace(/\\/g, '/')}", "w")
                f:write("written from lua")
                f:close()
            `)
            const content = readFileSync(testFile, 'utf8')
            expect(content).to.be.equal('written from lua')
        } finally {
            rmSync(tempDir, { recursive: true, force: true })
        }
    })

    it('NODEFS cwd should match process.cwd', async () => {
        const lua = await Lua.load({ fs: 'node' })
        const state = lua.createState()
        // Write a temp file in the CWD and verify it can be read
        const markerFile = join(process.cwd(), `.wasmoon-cwd-test-${Date.now()}.tmp`)
        writeFileSync(markerFile, 'cwd-marker')
        try {
            const result = await state.doString(`
                local f = io.open("${markerFile.replace(/\\/g, '/')}", "r")
                if not f then return nil end
                local content = f:read("*a")
                f:close()
                return content
            `)
            expect(result).to.be.equal('cwd-marker')
        } finally {
            rmSync(markerFile, { force: true })
        }
    })

    it('NODEFS with fsMountPaths should only mount specified paths', async () => {
        const tempDir = join(tmpdir(), `wasmoon-mount-test-${Date.now()}`)
        mkdirSync(tempDir, { recursive: true })
        const testFile = join(tempDir, 'specific.txt')
        writeFileSync(testFile, 'mounted content')

        try {
            const lua = await Lua.load({ fs: 'node', fsMountPaths: [tmpdir()] })
            const state = lua.createState()
            const result = await state.doString(`
                local f = io.open("${testFile.replace(/\\/g, '/')}", "r")
                if not f then return nil end
                local content = f:read("*a")
                f:close()
                return content
            `)
            expect(result).to.be.equal('mounted content')
        } finally {
            rmSync(tempDir, { recursive: true, force: true })
        }
    })

    it('NODEFS opening nonexistent file should return nil', async () => {
        const lua = await Lua.load({ fs: 'node' })
        const state = lua.createState()
        const result = await state.doString(`
            local f, err = io.open("/tmp/wasmoon_nonexistent_file_${Date.now()}.txt", "r")
            return f == nil and type(err) == "string"
        `)
        expect(result).to.be.true
    })

    it('mountFile and NODEFS should coexist', async () => {
        const tempDir = join(tmpdir(), `wasmoon-coexist-${Date.now()}`)
        mkdirSync(tempDir, { recursive: true })
        const hostFile = join(tempDir, 'host.txt')
        writeFileSync(hostFile, 'from host')

        try {
            const lua = await Lua.load({ fs: 'node' })
            lua.mountFile('virtual.lua', 'return "from virtual"')
            const state = lua.createState()

            const hostContent = await state.doString(`
                local f = io.open("${hostFile.replace(/\\/g, '/')}", "r")
                local content = f:read("*a")
                f:close()
                return content
            `)
            const virtualContent = await state.doString('return dofile("virtual.lua")')

            expect(hostContent).to.be.equal('from host')
            expect(virtualContent).to.be.equal('from virtual')
        } finally {
            rmSync(tempDir, { recursive: true, force: true })
            rmSync('virtual.lua', { force: true })
        }
    })

    it('standard libraries are available should succeed', async () => {
        const state = (await Lua.load()).createState()
        const result = await state.doString(`
            local checks = {}
            checks[1] = type(string.format) == "function"
            checks[2] = type(table.insert) == "function"
            checks[3] = type(math.floor) == "function"
            checks[4] = type(os.time) == "function"
            checks[5] = type(coroutine.create) == "function"
            for _, v in ipairs(checks) do
                if not v then return false end
            end
            return true
        `)
        expect(result).to.be.true
    })

    it('error handling with pcall should succeed', async () => {
        const state = (await Lua.load()).createState()
        const result = await state.doString(`
            local ok, err = pcall(function()
                error("node test error")
            end)
            return not ok and string.find(err, "node test error") ~= nil
        `)
        expect(result).to.be.true
    })
})
