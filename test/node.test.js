import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { expect } from 'chai'
import { LuaRuntime } from '../dist/index.js'

// stdin is closed by default, as it would be for a redirected or piped invocation with nothing
// to read.
const runCli = (args, input) => {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['bin/wasmoon', ...args], {
            stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => (stdout += chunk))
        child.stderr.on('data', (chunk) => (stderr += chunk))
        child.on('error', reject)
        child.on('close', (code) => resolve({ code, stdout, stderr }))
        if (input !== undefined) {
            child.stdin.end(input)
        }
    })
}

// Collects everything the given script writes to the chosen stream.
const collectOutput = async (stream, script, opts = {}) => {
    const output = []
    const lua = await LuaRuntime.load({ ...opts, [stream]: (content) => output.push(content) })
    await lua.createState().doString(script)
    return output
}

// Feeds one chunk per read, and then the empty string that stands for EOF.
const stdinFrom = (chunks) => {
    let index = 0
    return () => chunks[index++] ?? ''
}

describe('Node environment', () => {
    it('load Lua engine in node should succeed', async () => {
        const lua = await LuaRuntime.load()
        const state = lua.createState()
        const result = await state.doString('return 1 + 1')
        expect(result).to.be.equal(2)
    })

    it('access environment variables should succeed', async () => {
        const env = { MY_TEST_VAR: 'hello_from_node' }
        const lua = await LuaRuntime.load({ env })
        const state = lua.createState()
        const result = await state.doString('return os.getenv("MY_TEST_VAR")')
        expect(result).to.be.equal('hello_from_node')
    })

    it('custom stdout should succeed', async () => {
        const output = await collectOutput('stdout', 'print("hello from node")')
        expect(output.join('')).to.include('hello from node')
    })

    it('custom stderr should succeed', async () => {
        const errors = await collectOutput('stderr', 'io.stderr:write("error output\\n")')
        expect(errors.join('')).to.include('error output')
    })

    it('mount file and require in node should succeed', async () => {
        const lua = await LuaRuntime.load()
        lua.mountFile('nodetest.lua', 'return { value = 99 }')
        const state = lua.createState({ inject: true })
        const result = await state.doString('local m = require("nodetest"); return m.value')
        expect(result).to.be.equal(99)
    })

    it('mount file with binary content should succeed', async () => {
        const lua = await LuaRuntime.load()
        const content = new Uint8Array([114, 101, 116, 117, 114, 110, 32, 52, 50]) // "return 42"
        lua.mountFile('binary.lua', content)
        const state = lua.createState()
        const result = await state.doString('return dofile("binary.lua")')
        expect(result).to.be.equal(42)
    })

    it('mount file in nested directories should succeed', async () => {
        const lua = await LuaRuntime.load()
        lua.mountFile('a/b/c/deep.lua', 'return "deep"')
        const state = lua.createState()
        const result = await state.doString('return require("a/b/c/deep")')
        expect(result).to.be.equal('deep')
    })

    it('create multiple independent states should succeed', async () => {
        const lua = await LuaRuntime.load()
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
        const state = (await LuaRuntime.load()).createState({ inject: true })
        state.set('data', {
            name: 'test',
            nested: { value: 42 },
            items: [1, 2, 3],
        })
        const result = await state.doString('return data.nested.value')
        expect(result).to.be.equal(42)
    })

    it('call JS async functions from Lua should succeed', async () => {
        const state = (await LuaRuntime.load()).createState({ inject: true })
        state.set('fetchData', async () => {
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
            const lua = await LuaRuntime.load({ fs: 'node' })
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
            const lua = await LuaRuntime.load({ fs: 'node' })
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
        const lua = await LuaRuntime.load({ fs: 'node' })
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
            const lua = await LuaRuntime.load({ fs: 'node', fsMountPaths: [tmpdir()] })
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
        const lua = await LuaRuntime.load({ fs: 'node' })
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
            const lua = await LuaRuntime.load({ fs: 'node' })
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
        const state = (await LuaRuntime.load()).createState()
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
        const state = (await LuaRuntime.load()).createState()
        const result = await state.doString(`
            local ok, err = pcall(function()
                error("node test error")
            end)
            return not ok and string.find(err, "node test error") ~= nil
        `)
        expect(result).to.be.true
    })

    it('custom stdout should keep multi byte characters intact', async () => {
        const output = await collectOutput('stdout', 'print("héllo 日本語 🎉")')
        expect(output).to.be.deep.equal(['héllo 日本語 🎉'])
    })

    it('custom stderr should keep multi byte characters intact', async () => {
        const errors = await collectOutput('stderr', 'io.stderr:write("erro ✗ 日本\\n")')
        expect(errors).to.be.deep.equal(['erro ✗ 日本'])
    })

    it('custom stdout should keep a character that is flushed in the middle intact', async () => {
        // The two halves of 日 land in different writes, with the engine handing control back to
        // JS in between.
        const output = []
        const lua = await LuaRuntime.load({ stdout: (content) => output.push(content) })
        const state = lua.createState()
        state.set(
            'pause',
            () =>
                new Promise((resolve) => {
                    setTimeout(resolve, 0)
                }),
        )
        await state.doString('io.write("\\xE6") io.flush() pause():await() io.write("\\x97\\xA5 ok\\n")')
        expect(output).to.be.deep.equal(['日 ok'])
    })

    it('custom stdout should split on line breaks only', async () => {
        const output = await collectOutput('stdout', 'print("first") print("") io.write("a\\rb\\n")')
        expect(output).to.be.deep.equal(['first', '', 'a\rb'])
    })

    it('custom stdout should receive flushed output that does not end in a line break', async () => {
        const output = await collectOutput('stdout', 'io.write("no newline") io.flush()')
        expect(output).to.be.deep.equal(['no newline'])
    })

    it('custom stdout should not split a line that is written in parts', async () => {
        const output = await collectOutput('stdout', 'io.write("one ") io.flush() io.write("line\\n")')
        expect(output).to.be.deep.equal(['one line'])
    })

    it('custom stdout should handle lines longer than its buffer', async () => {
        const output = await collectOutput('stdout', 'print(string.rep("ção ", 1000))')
        expect(output).to.be.deep.equal(['ção '.repeat(1000)])
    })

    it('custom stdin should be read line by line', async () => {
        const lua = await LuaRuntime.load({ stdin: stdinFrom(['um\n', 'dois\n']) })
        const result = await lua.createState().doString('return { io.read("l"), io.read("l"), io.read("l") == nil }')
        expect(result).to.be.deep.equal(['um', 'dois', true])
    })

    it('custom stdin should keep multi byte characters intact', async () => {
        const lua = await LuaRuntime.load({ stdin: stdinFrom(['héllo 日本語 🎉\n']) })
        const result = await lua.createState().doString('return io.read("l")')
        expect(result).to.be.equal('héllo 日本語 🎉')
    })

    it('custom stdin should be read until it signals the end of the input', async () => {
        const lua = await LuaRuntime.load({ stdin: stdinFrom(['abc\n', 'déf\n']) })
        const result = await lua.createState().doString('return io.read("a")')
        expect(result).to.be.equal('abc\ndéf\n')
    })

    it('cli should read piped input from within a script', async function () {
        this.timeout(30_000)
        const { code, stdout, stderr } = await runCli(
            ['-e', 'print(io.read("l")) print(io.read("l")) print(io.read("l") == nil)'],
            'olá mundo\nsegunda linha\n',
        )

        expect(stderr).to.be.empty
        expect(code).to.be.equal(0)
        expect(stdout).to.be.equal('olá mundo\nsegunda linha\ntrue\n')
    })

    it('cli should not add a line break to input that does not end with one', async function () {
        this.timeout(30_000)
        const { code, stdout, stderr } = await runCli(['-e', 'print(#io.read("a"))'], 'abc')

        expect(stderr).to.be.empty
        expect(code).to.be.equal(0)
        expect(stdout).to.be.equal('3\n')
    })

    it('cli should not run piped input as a script when -e is given', async function () {
        this.timeout(30_000)
        const { code, stdout, stderr } = await runCli(['-e', 'print("from -e")'], 'this is not lua code\n')

        expect(stderr).to.be.empty
        expect(code).to.be.equal(0)
        expect(stdout).to.be.equal('from -e\n')
    })

    it('cli should expose arg as a lua table', async function () {
        this.timeout(30_000)
        const directory = mkdtempSync(join(tmpdir(), 'wasmoon-cli-'))
        const script = join(directory, 'args.lua')
        writeFileSync(script, 'print(type(arg), #arg, arg[1], arg[2], table.concat(arg, "+"))')

        const { code, stdout, stderr } = await runCli([script, 'first', 'second'])

        expect(stderr).to.be.empty
        expect(code).to.be.equal(0)
        expect(stdout.trim()).to.be.equal('table\t2\tfirst\tsecond\tfirst+second')
    })
})
