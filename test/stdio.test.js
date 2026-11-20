import { expect } from 'chai'
import { LuaRuntime } from '../dist/index.js'

const collectOutput = async (stream, script) => {
    const output = []
    const lua = await LuaRuntime.load({ [stream]: (content) => output.push(content) })
    await lua.createState().doString(script)
    return output
}

// The empty string is what signals EOF, so reads past the end have to return it rather than undefined.
const stdinFrom = (chunks) => {
    let index = 0
    return () => chunks[index++] ?? ''
}

describe('Custom stdout', () => {
    it('should receive what the script prints', async () => {
        const output = await collectOutput('stdout', 'print("hello from node")')

        expect(output).to.be.deep.equal(['hello from node'])
    })

    it('should keep multi byte characters intact', async () => {
        const output = await collectOutput('stdout', 'print("héllo 日本語 🎉")')

        expect(output).to.be.deep.equal(['héllo 日本語 🎉'])
    })

    it('should keep a character that is flushed in the middle intact', async () => {
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

    it('should split on line breaks only', async () => {
        const output = await collectOutput('stdout', 'print("first") print("") io.write("a\\rb\\n")')

        expect(output).to.be.deep.equal(['first', '', 'a\rb'])
    })

    it('should receive flushed output that does not end in a line break', async () => {
        const output = await collectOutput('stdout', 'io.write("no newline") io.flush()')

        expect(output).to.be.deep.equal(['no newline'])
    })

    it('should not split a line that is written in parts', async () => {
        const output = await collectOutput('stdout', 'io.write("one ") io.flush() io.write("line\\n")')

        expect(output).to.be.deep.equal(['one line'])
    })

    it('should handle lines longer than its buffer', async () => {
        const output = await collectOutput('stdout', 'print(string.rep("ção ", 1000))')

        expect(output).to.be.deep.equal(['ção '.repeat(1000)])
    })
})

describe('Custom stderr', () => {
    it('should receive what the script writes', async () => {
        const errors = await collectOutput('stderr', 'io.stderr:write("error output\\n")')

        expect(errors).to.be.deep.equal(['error output'])
    })

    it('should keep multi byte characters intact', async () => {
        const errors = await collectOutput('stderr', 'io.stderr:write("erro ✗ 日本\\n")')

        expect(errors).to.be.deep.equal(['erro ✗ 日本'])
    })
})

describe('Custom stdin', () => {
    it('should be read line by line', async () => {
        const lua = await LuaRuntime.load({ stdin: stdinFrom(['um\n', 'dois\n']) })

        const result = await lua.createState().doString('return { io.read("l"), io.read("l"), io.read("l") == nil }')

        expect(result).to.be.deep.equal(['um', 'dois', true])
    })

    it('should keep multi byte characters intact', async () => {
        const lua = await LuaRuntime.load({ stdin: stdinFrom(['héllo 日本語 🎉\n']) })

        const result = await lua.createState().doString('return io.read("l")')

        expect(result).to.be.equal('héllo 日本語 🎉')
    })

    it('should be read until it signals the end of the input', async () => {
        const lua = await LuaRuntime.load({ stdin: stdinFrom(['abc\n', 'déf\n']) })

        const result = await lua.createState().doString('return io.read("a")')

        expect(result).to.be.equal('abc\ndéf\n')
    })
})
