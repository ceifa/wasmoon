import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { expect } from 'chai'
import { rolldown } from 'rolldown'

const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url))
const WASM_FILE = join(DIST_DIR, 'glue.wasm')

/**
 * Consumers bundle us through a minifier, so anything in the published bundle that depends on a name
 * surviving breaks in their build and not in ours. These run it against a minified copy.
 */
describe('Bundling', () => {
    let tempDir
    let minified

    before(async function () {
        this.timeout(60_000)
        tempDir = await mkdtemp(join(tmpdir(), 'wasmoon-bundling-'))

        const bundle = await rolldown({
            input: join(DIST_DIR, 'index.js'),
            external: ['node:module', 'node:fs'],
        })
        await bundle.write({ file: join(tempDir, 'index.js'), format: 'esm', minify: true })
        await bundle.close()

        minified = await import(join(tempDir, 'index.js'))
    })

    after(async () => {
        if (tempDir) {
            await rm(tempDir, { recursive: true, force: true })
        }
    })

    const getMinifiedState = async (config = {}) => {
        const lua = await minified.LuaRuntime.load({ wasmFile: WASM_FILE })
        return lua.createState({ inject: true, ...config })
    }

    it('minifying the bundle renames the unwind classes', async () => {
        // The premise of the tests below: a check by class name has nothing left to match on.
        const code = await readFile(join(tempDir, 'index.js'), 'utf8')
        expect(code).to.not.match(/class Emscripten/)
    })

    it('a yield across a C-call boundary still surfaces as an error when minified', async () => {
        const state = await getMinifiedState()
        const emitter = new EventEmitter()
        state.set('yield', () => new Promise((resolve) => emitter.once('resolve', resolve)))
        const resPromise = state.doString(`
            local res = yield():next(function ()
                coroutine.yield()
                return 15
            end)
            print("res", res:await())
        `)

        emitter.emit('resolve')
        await expect(resPromise).to.eventually.be.rejectedWith('Error: attempt to yield across a C-call boundary')

        expect(await state.doString('return 42')).to.equal(42)
    })

    it('a thread timeout inside a JS callback still surfaces as an error when minified', async () => {
        const state = await getMinifiedState({ limits: { functionTimeout: 10 } })
        state.set('promise', Promise.resolve())
        const thread = state.newThread()
        thread.loadString(`
            promise:next(function ()
                while true do
                  -- nothing
                end
            end):await()
        `)
        await expect(thread.run(0, { timeout: 5 })).to.eventually.be.rejectedWith('thread timeout exceeded')

        expect(await state.doString('return 42')).to.equal(42)
    })
})
