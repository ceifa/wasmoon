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

// For the runs that are expected to succeed, which is most of them: the only interesting part is
// what reached stdout.
const runOk = async (args, options) => {
    const { code, stdout, stderr } = await runCli(args, options)

    expect(stderr, 'stderr').to.be.empty
    expect(code, 'exit code').to.be.equal(0)
    return stdout
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

    const writeScript = (name, body) => {
        const path = join(tempDir, name)
        writeFileSync(path, body)
        return path
    }

    describe('scripts and snippets', () => {
        // Covers the single snippet case too, which is why there is no separate test for it.
        it('should run several -e snippets in order', async () => {
            expect(await runOk(['-e', 'print("first")', '-e', 'print("second")'])).to.be.equal('first\nsecond\n')
        })

        it('should run a script file', async () => {
            const script = writeScript('hello.lua', 'print("from file")')

            expect(await runOk([script])).to.be.equal('from file\n')
        })

        it('should run a script piped to stdin', async () => {
            expect(await runOk([], { input: 'print("from bare stdin")\n' })).to.be.equal('from bare stdin\n')
        })

        it('should run a script piped to stdin when given -', async () => {
            expect(await runOk(['-'], { input: 'print("from dash")\n' })).to.be.equal('from dash\n')
        })
    })

    describe('arg table', () => {
        it('should expose arg as a lua table to a script', async () => {
            const script = writeScript('args.lua', 'print(type(arg), #arg, arg[1], arg[2], table.concat(arg, "+"))')

            const stdout = await runOk([script, 'first', 'second'])

            expect(stdout.trim()).to.be.equal('table\t2\tfirst\tsecond\tfirst+second')
        })

        // The table is aligned on the script name, so it sits at index 0 with the interpreter and
        // the options that came before it at negative indices.
        it('should align arg on the script name', async () => {
            const script = writeScript('align.lua', 'print(arg[0], arg[-1], arg[-2])')

            const stdout = await runOk(['-e', '', script])

            expect(stdout.trim().split('\t')).to.deep.equal([script, '', '-e'])
        })

        // Without a script the alignment falls back to the interpreter, which puts the options
        // themselves at positive indices.
        it('should align arg on the interpreter when there is no script', async () => {
            const stdout = await runOk(['-e', 'print(type(arg), #arg, arg[1], arg[2])'])

            expect(stdout.trim()).to.be.equal('table\t2\t-e\tprint(type(arg), #arg, arg[1], arg[2])')
        })

        it('should pass the script arguments to the script as varargs', async () => {
            const script = writeScript('varargs.lua', 'print(...)')

            expect((await runOk([script, 'first', 'second'])).trim()).to.be.equal('first\tsecond')
        })

        it('should treat whatever follows -- as the script, even when it looks like an option', async () => {
            const script = writeScript('-notaflag.lua', 'print("ran", ...)')

            expect((await runOk(['--', script, 'tail'])).trim()).to.be.equal('ran\ttail')
        })

        it('should run nothing but the options when -- ends the arguments', async () => {
            expect(await runOk(['-e', 'print("only e")', '--'])).to.be.equal('only e\n')
        })
    })

    describe('options', () => {
        it('-v should report both versions', async () => {
            const stdout = await runOk(['-v'])

            expect(stdout.trim()).to.match(/^wasmoon \S+ \(Lua [\d.]+\)$/)
            expect(stdout).to.include(`wasmoon ${pkg.version} `)
        })

        // -v reports and carries on, rather than being a request to do nothing else.
        it('-v should still run whatever else was asked for', async () => {
            const stdout = await runOk(['-v', '-e', 'print("ran")'])

            expect(stdout.trim().split('\n')).to.have.lengthOf(2)
            expect(stdout).to.match(/^wasmoon .*\nran\n$/)
        })

        // It still counts as something to do, so stdin is not read as a program on top of it.
        it('-v alone should not run stdin', async () => {
            expect(await runOk(['-v'], { input: 'print("should not run")\n' })).to.not.include('should not run')
        })

        it('should run -e and -l in the order they were given', async () => {
            writeScript('noisy.lua', 'print("module") return {}')

            const [eFirst, lFirst] = await Promise.all([
                runOk(['-e', 'print("snippet")', '-l', 'noisy'], { cwd: tempDir }),
                runOk(['-l', 'noisy', '-e', 'print("snippet")'], { cwd: tempDir }),
            ])

            expect(eFirst).to.be.equal('snippet\nmodule\n')
            expect(lFirst).to.be.equal('module\nsnippet\n')
        })

        // The global has to hold the very table package.loaded does, not a copy of it.
        it('-l should require a module into a global of the same name', async () => {
            writeScript('mymod.lua', 'return { v = 5 }')

            const stdout = await runOk(['-l', 'mymod', '-e', 'print(mymod.v, type(mymod), mymod == package.loaded.mymod)'], {
                cwd: tempDir,
            })

            expect(stdout.trim()).to.be.equal('5\ttable\ttrue')
        })

        it('-l g=mod should require a module into a renamed global', async () => {
            writeScript('mymod.lua', 'return { v = 5 }')

            const stdout = await runOk(['-l', 'g=mymod', '-e', 'print(g.v, mymod)'], { cwd: tempDir })

            expect(stdout.trim()).to.be.equal('5\tnil')
        })

        it('-E should hide the host environment', async () => {
            const env = { ...process.env, WASMOON_CLI_TEST: 'secret' }

            const [withEnv, without] = await Promise.all([
                runOk(['-e', 'print(os.getenv("WASMOON_CLI_TEST"))'], { env }),
                runOk(['-E', '-e', 'print(os.getenv("WASMOON_CLI_TEST"))'], { env }),
            ])

            expect(withEnv.trim()).to.be.equal('secret')
            expect(without.trim()).to.be.equal('nil')
        })

        it('an unrecognized option should print usage and fail', async () => {
            const { code, stdout, stderr } = await runCli(['-Z'])

            expect(code).to.be.equal(1)
            expect(stdout).to.be.empty
            expect(stderr).to.include(`unrecognized option: '-Z'`)
            expect(stderr).to.include('usage: wasmoon')
        })

        it('a missing argument after -e should fail', async () => {
            const { code, stderr } = await runCli(['-e'])

            expect(code).to.be.equal(1)
            expect(stderr).to.include('Missing argument after -e')
        })
    })

    describe('errors', () => {
        it('should report a runtime error with a traceback and fail', async () => {
            const { code, stdout, stderr } = await runCli(['-e', 'error("boom")'])

            expect(code).to.be.equal(1)
            expect(stdout).to.be.empty
            expect(stderr).to.include('wasmoon: (command line):1: boom')
            expect(stderr).to.include('stack traceback:')
            // A Lua error is a diagnostic, not a crash of the interpreter itself.
            expect(stderr).to.not.include('LuaError')
        })

        it('should report a script that cannot be opened without a traceback', async () => {
            const missing = join(tempDir, 'missing.lua')

            const { code, stdout, stderr } = await runCli([missing])

            expect(code).to.be.equal(1)
            expect(stdout).to.be.empty
            expect(stderr).to.include(`wasmoon: cannot open ${missing}`)
            expect(stderr).to.not.include('stack traceback:')
        })

        it('should stop before the script when a -e snippet fails', async () => {
            const script = writeScript('unreached.lua', 'print("unreached")')

            const { code, stdout } = await runCli(['-e', 'error("boom")', script])

            expect(code).to.be.equal(1)
            expect(stdout).to.be.empty
        })

        it('should report a failing -l without running the rest', async () => {
            const { code, stdout, stderr } = await runCli(['-l', 'nosuchmodule', '-e', 'print("unreached")'])

            expect(code).to.be.equal(1)
            expect(stdout).to.be.empty
            expect(stderr).to.include("wasmoon: module 'nosuchmodule' not found")
        })
    })

    describe('os.exit', () => {
        it('should exit with the status the script asked for', async () => {
            const { code, stdout, stderr } = await runCli(['-e', 'print("bye") os.exit(3)'])

            expect(stderr).to.be.empty
            expect(code).to.be.equal(3)
            expect(stdout).to.be.equal('bye\n')
        })

        it('should treat a boolean status the way lua does', async () => {
            const [ok, notOk] = await Promise.all([runCli(['-e', 'os.exit(true)']), runCli(['-e', 'os.exit(false)'])])

            expect(ok.code).to.be.equal(0)
            expect(notOk.code).to.be.equal(1)
            expect(ok.stderr).to.be.empty
            expect(notOk.stderr).to.be.empty
        })

        it('should exit successfully with no status', async () => {
            const { code, stderr } = await runCli(['-e', 'os.exit()'])

            expect(stderr).to.be.empty
            expect(code).to.be.equal(0)
        })
    })

    describe('stdin', () => {
        it('should read piped input from within a script', async () => {
            const stdout = await runOk(['-e', 'print(io.read("l")) print(io.read("l")) print(io.read("l") == nil)'], {
                input: 'olá mundo\nsegunda linha\n',
            })

            expect(stdout).to.be.equal('olá mundo\nsegunda linha\ntrue\n')
        })

        it('should not add a line break to input that does not end with one', async () => {
            expect(await runOk(['-e', 'print(#io.read("a"))'], { input: 'abc' })).to.be.equal('3\n')
        })

        // A named '-' is a script and is called like one; stdin falling in because nothing else was
        // named is not, so the options in front of it are not arguments to it.
        it('should only pass varargs to stdin when it was named with -', async () => {
            const [named, fallback] = await Promise.all([
                runOk(['-', 'one', 'two'], { input: 'print("varargs:", ...)\n' }),
                runOk(['-W'], { input: 'print("varargs:", ...)\n' }),
            ])

            expect(named.trim()).to.be.equal('varargs:\tone\ttwo')
            expect(fallback.trim()).to.be.equal('varargs:')
        })

        it('should not run piped input as a script when -e is given', async () => {
            expect(await runOk(['-e', 'print("from -e")'], { input: 'this is not lua code\n' })).to.be.equal('from -e\n')
        })
    })
})
