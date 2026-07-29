import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect } from 'chai'
import pkg from '../package.json' with { type: 'json' }

// Absolute, so a test can hand the child a cwd of its own.
const CLI = fileURLToPath(new URL('../bin/wasmoon', import.meta.url))

// stdin defaults to closed, matching a piped invocation with nothing to read. Never a TTY here,
// so the REPL branch and `-i` stay out of reach.
const runCli = (args, { input, ...options } = {}) => {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, ...args], {
            stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
            ...options,
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

describe('CLI', function () {
    this.timeout(30_000)

    let tempDir

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'wasmoon-cli-'))
    })

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true })
    })

    describe('scripts and snippets', () => {
        // Covers the single snippet case too, which is why there is no separate test for it.
        it('should run several -e snippets in order', async () => {
            const { code, stdout, stderr } = await runCli(['-e', 'print("first")', '-e', 'print("second")'])

            expect(stderr).to.be.empty
            expect(code).to.be.equal(0)
            expect(stdout).to.be.equal('first\nsecond\n')
        })

        it('should run a script file', async () => {
            const script = join(tempDir, 'hello.lua')
            writeFileSync(script, 'print("from file")')

            const { code, stdout } = await runCli([script])

            expect(code).to.be.equal(0)
            expect(stdout).to.be.equal('from file\n')
        })

        it('should run a script piped to stdin', async () => {
            const { code, stdout } = await runCli([], { input: 'print("from bare stdin")\n' })

            expect(code).to.be.equal(0)
            expect(stdout).to.be.equal('from bare stdin\n')
        })

        it('should run a script piped to stdin when given -', async () => {
            const { code, stdout } = await runCli(['-'], { input: 'print("from dash")\n' })

            expect(code).to.be.equal(0)
            expect(stdout).to.be.equal('from dash\n')
        })
    })

    describe('arg table', () => {
        it('should expose arg as a lua table to a script', async () => {
            const script = join(tempDir, 'args.lua')
            writeFileSync(script, 'print(type(arg), #arg, arg[1], arg[2], table.concat(arg, "+"))')

            const { code, stdout, stderr } = await runCli([script, 'first', 'second'])

            expect(stderr).to.be.empty
            expect(code).to.be.equal(0)
            expect(stdout.trim()).to.be.equal('table\t2\tfirst\tsecond\tfirst+second')
        })

        // arg used to be built after the -e loop ran, so a snippet saw a nil global.
        it('should expose arg to a -e snippet', async () => {
            const { code, stdout, stderr } = await runCli(['-e', 'print(type(arg), #arg)'])

            expect(stderr).to.be.empty
            expect(code).to.be.equal(0)
            expect(stdout.trim()).to.be.equal('table\t0')
        })

        it('should pass arguments after -- through to arg', async () => {
            const { code, stdout, stderr } = await runCli(['-e', 'print(arg[1])', '--', '--notaflag'])

            expect(stderr).to.be.empty
            expect(code).to.be.equal(0)
            expect(stdout.trim()).to.be.equal('--notaflag')
        })
    })

    describe('options', () => {
        it('-v should report both versions', async () => {
            const { code, stdout } = await runCli(['-v'])

            expect(code).to.be.equal(0)
            expect(stdout.trim()).to.match(/^wasmoon \S+ \(Lua [\d.]+\)$/)
            expect(stdout).to.include(`wasmoon ${pkg.version} `)
        })

        it('-l should require a module into a global of the same name', async () => {
            writeFileSync(join(tempDir, 'mymod.lua'), 'return { v = 5 }')

            const { code, stdout } = await runCli(['-l', 'mymod', '-e', 'print(mymod.v)'], { cwd: tempDir })

            expect(code).to.be.equal(0)
            expect(stdout.trim()).to.be.equal('5')
        })

        it('-l g=mod should require a module into a renamed global', async () => {
            writeFileSync(join(tempDir, 'mymod.lua'), 'return { v = 5 }')

            const { code, stdout } = await runCli(['-l', 'g=mymod', '-e', 'print(g.v, mymod)'], { cwd: tempDir })

            expect(code).to.be.equal(0)
            expect(stdout.trim()).to.be.equal('5\tnil')
        })

        it('-E should hide the host environment', async () => {
            const env = { ...process.env, WASMOON_CLI_TEST: 'secret' }

            const [withEnv, without] = await Promise.all([
                runCli(['-e', 'print(os.getenv("WASMOON_CLI_TEST"))'], { env }),
                runCli(['-E', '-e', 'print(os.getenv("WASMOON_CLI_TEST"))'], { env }),
            ])

            expect(withEnv.stdout.trim()).to.be.equal('secret')
            expect(without.stdout.trim()).to.be.equal('nil')
        })

        it('an unrecognized option should print usage and fail', async () => {
            const { code, stdout } = await runCli(['-Z'])

            expect(code).to.be.equal(1)
            expect(stdout).to.include(`unrecognized option: '-Z'`)
            expect(stdout).to.include('usage: wasmoon')
        })

        it('a missing argument after -e should fail', async () => {
            const { code, stderr } = await runCli(['-e'])

            expect(code).to.be.equal(1)
            expect(stderr).to.include('Missing argument after -e')
        })
    })

    describe('stdin', () => {
        it('should read piped input from within a script', async () => {
            const { code, stdout, stderr } = await runCli(['-e', 'print(io.read("l")) print(io.read("l")) print(io.read("l") == nil)'], {
                input: 'olá mundo\nsegunda linha\n',
            })

            expect(stderr).to.be.empty
            expect(code).to.be.equal(0)
            expect(stdout).to.be.equal('olá mundo\nsegunda linha\ntrue\n')
        })

        it('should not add a line break to input that does not end with one', async () => {
            const { code, stdout, stderr } = await runCli(['-e', 'print(#io.read("a"))'], { input: 'abc' })

            expect(stderr).to.be.empty
            expect(code).to.be.equal(0)
            expect(stdout).to.be.equal('3\n')
        })

        it('should not run piped input as a script when -e is given', async () => {
            const { code, stdout, stderr } = await runCli(['-e', 'print("from -e")'], { input: 'this is not lua code\n' })

            expect(stderr).to.be.empty
            expect(code).to.be.equal(0)
            expect(stdout).to.be.equal('from -e\n')
        })
    })
})
