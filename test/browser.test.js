import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'chai'
import { chromium } from 'playwright'

const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url))

function startServer() {
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.wasm': 'application/wasm',
        '.map': 'application/json',
    }

    const testPage = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<script type="module">
const wasmFile = new URL('./glue.wasm', location.href).href
window.__runTest = async (code) => {
    const { default: LuaRuntime } = await import('./index.js')
    const fn = new Function('LuaRuntime', 'wasmFile', 'return (async () => {' + code + '})()')
    return await fn(LuaRuntime, wasmFile)
}
window.__ready = true
</script>
</body></html>`

    // A module worker resolves the wasm the same way a page does, but with no `window` in scope.
    const workerScript = `
import LuaRuntime from './index.js'
self.onmessage = async () => {
    try {
        const lua = await LuaRuntime.load()
        const state = lua.createState()
        self.postMessage({ ok: await state.doString('return 2 + 5') })
    } catch (err) {
        self.postMessage({ error: String(err) })
    }
}
`

    const server = createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost`)

        if (url.pathname === '/' || url.pathname === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(testPage)
            return
        }

        if (url.pathname === '/worker.js') {
            res.writeHead(200, { 'Content-Type': 'application/javascript' })
            res.end(workerScript)
            return
        }

        const filePath = join(DIST_DIR, url.pathname)

        try {
            const data = await readFile(filePath)
            const ext = url.pathname.substring(url.pathname.lastIndexOf('.'))
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' })
            res.end(data)
        } catch {
            res.writeHead(404)
            res.end('Not found')
        }
    })

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address()
            resolve({ server, port })
        })
    })
}

describe('Browser environment', () => {
    let port, server, browser, context

    before(async function () {
        this.timeout(30_000)
        ;({ server, port } = await startServer())
        browser = await chromium.launch()
        context = await browser.newContext()
    })

    after(async () => {
        await browser?.close()
        server?.close()
    })

    /** Every URL the page asked for, so a test can tell where the wasm was fetched from. */
    let requested = []

    async function openPage() {
        const page = await context.newPage()
        requested = []
        page.on('request', (req) => requested.push(req.url()))

        const errors = []
        page.on('pageerror', (err) => errors.push(err))
        page.assertNoErrors = () => {
            if (errors.length > 0) {
                throw errors[0]
            }
        }

        await page.goto(`http://127.0.0.1:${port}/`)
        await page.waitForFunction(() => window.__ready === true, null, { timeout: 15_000 })
        return page
    }

    function expectNoExternalRequests() {
        expect(requested.filter((url) => !url.startsWith(`http://127.0.0.1:${port}/`))).to.be.empty
    }

    async function runInBrowser(code) {
        const page = await openPage()

        try {
            const result = await page.evaluate(async (c) => {
                return await window.__runTest(c)
            }, code)

            page.assertNoErrors()
            return result
        } finally {
            await page.close()
        }
    }

    for (const engine of ['yield', 'jspi']) {
        it(`isolates async runs and lets timers run under ${engine}`, async function () {
            this.timeout(30_000)
            const result = await runInBrowser(`
                const runtime = await LuaRuntime.load({ wasmFile, async: '${engine}' })
                const state = runtime.createState()
                try {
                    let fired = false
                    state.set('ready', Promise.resolve())
                    state.set('fired', () => fired)
                    setTimeout(() => { fired = true }, 0)
                    const fair = await state.doString('for i=1,10000 do ready:await() if fired() then return true end end return false')
                    let releaseFirst, releaseOther
                    state.set('first', new Promise((resolve) => { releaseFirst = resolve }))
                    state.set('other', new Promise((resolve) => { releaseOther = resolve }))
                    state.set('never', new Promise(() => {}))
                    const timed = state.doString('first:await() never:await()', { timeout: 30 }).catch((error) => error.name)
                    const other = state.doString('other:await() return 42')
                    releaseFirst()
                    const error = await timed
                    releaseOther()
                    return { fair, error, other: await other }
                } finally {
                    state.close()
                }
            `)
            expect(result).to.eql({ fair: true, error: 'LuaTimeoutError', other: 42 })
        })
    }

    it('load Lua engine in browser should succeed', async function () {
        this.timeout(30_000)
        const result = await runInBrowser(`
            const lua = await LuaRuntime.load({ wasmFile })
            const state = lua.createState()
            return state !== undefined
        `)
        expect(result).to.be.true
    })

    it('execute Lua code in browser should succeed', async function () {
        this.timeout(30_000)
        const result = await runInBrowser(`
            const lua = await LuaRuntime.load({ wasmFile })
            const state = lua.createState()
            return await state.doString('return 2 + 2')
        `)
        expect(result).to.be.equal(4)
    })

    it('pass JS values to Lua and back in browser should succeed', async function () {
        this.timeout(30_000)
        const result = await runInBrowser(`
            const lua = await LuaRuntime.load({ wasmFile })
            const state = lua.createState({ inject: true })
            state.set('name', 'wasmoon')
            return await state.doString('return "hello " .. name')
        `)
        expect(result).to.be.equal('hello wasmoon')
    })

    it('call JS function from Lua in browser should succeed', async function () {
        this.timeout(30_000)
        const result = await runInBrowser(`
            const lua = await LuaRuntime.load({ wasmFile })
            const state = lua.createState({ inject: true })
            state.set('add', (a, b) => a + b)
            return await state.doString('return add(10, 20)')
        `)
        expect(result).to.be.equal(30)
    })

    it('mount and require a file in browser should succeed', async function () {
        this.timeout(30_000)
        const result = await runInBrowser(`
            const lua = await LuaRuntime.load({ wasmFile })
            lua.writeFile('mymodule.lua', 'return 42')
            const state = lua.createState()
            return await state.doString('return require("mymodule")')
        `)
        expect(result).to.be.equal(42)
    })

    it('handle Lua tables as JS objects in browser should succeed', async function () {
        this.timeout(30_000)
        const result = await runInBrowser(`
            const lua = await LuaRuntime.load({ wasmFile })
            const state = lua.createState({ inject: true })
            const value = await state.doString('return { x = 10, y = 20 }')
            return { x: value.x, y: value.y }
        `)
        expect(result).to.be.eql({ x: 10, y: 20 })
    })

    it('handle errors in browser should succeed', async function () {
        this.timeout(30_000)
        const result = await runInBrowser(`
            const lua = await LuaRuntime.load({ wasmFile })
            const state = lua.createState()
            try {
                await state.doString('error("test error")')
                return false
            } catch (e) {
                return e.message.includes('test error')
            }
        `)
        expect(result).to.be.true
    })

    it('use coroutines in browser should succeed', async function () {
        this.timeout(30_000)
        const result = await runInBrowser(`
            const lua = await LuaRuntime.load({ wasmFile })
            const state = lua.createState()
            return await state.doString(\`
                local co = coroutine.create(function()
                    coroutine.yield(1)
                    coroutine.yield(2)
                    return 3
                end)
                local results = {}
                while true do
                    local ok, value = coroutine.resume(co)
                    if not ok then break end
                    results[#results + 1] = value
                    if coroutine.status(co) == "dead" then break end
                end
                return results[1] + results[2] + results[3]
            \`)
        `)
        expect(result).to.be.equal(6)
    })

    it('yielding at the top level in browser should succeed', async function () {
        this.timeout(30_000)
        // Browsers have no setImmediate, which the yield path used to depend on.
        const result = await runInBrowser(`
            const lua = await LuaRuntime.load({ wasmFile })
            const state = lua.createState()
            return await state.doString('coroutine.yield() return 7')
        `)
        expect(result).to.be.equal(7)
    })

    // Every test above passes an explicit wasmFile, which a consumer does not. Without one, the
    // wrong default is a request to a CDN pinned to whatever version is in package.json.
    describe('default wasm resolution', () => {
        it('loads the wasm from the same origin when served over http', async function () {
            this.timeout(30_000)
            const result = await runInBrowser('await LuaRuntime.load(); return 1')

            expect(result).to.be.equal(1)
            expect(requested).to.include(`http://127.0.0.1:${port}/glue.wasm`)
            expectNoExternalRequests()
        })

        it('loads the wasm from the same origin inside a module worker', async function () {
            this.timeout(30_000)
            const page = await openPage()

            try {
                const result = await page.evaluate(async () => {
                    const worker = new Worker('/worker.js', { type: 'module' })
                    const message = new Promise((resolve) => worker.addEventListener('message', (e) => resolve(e.data)))
                    worker.postMessage('go')
                    return await message
                })

                page.assertNoErrors()
                expect(result).to.be.eql({ ok: 7 })
                expect(requested).to.include(`http://127.0.0.1:${port}/glue.wasm`)
                expectNoExternalRequests()
            } finally {
                await page.close()
            }
        })

        it('falls back to the CDN for a page opened from file:', async function () {
            this.timeout(60_000)
            // Served locally rather than for real, to keep the suite offline and because the
            // published wasm belongs to another version.
            const { htmlFile, cleanup } = await writeInlinedPage()
            const page = await context.newPage()
            const cdnRequests = []

            try {
                await page.route('https://unpkg.com/**', async (route) => {
                    cdnRequests.push(route.request().url())
                    await route.fulfill({ contentType: 'application/wasm', body: await readFile(join(DIST_DIR, 'glue.wasm')) })
                })

                await page.goto(`file://${htmlFile}`)
                await page.waitForFunction(() => window.__ready === true, null, { timeout: 15_000 })
                const result = await page.evaluate(async () => {
                    const lua = await window.__LuaRuntime.load()
                    return await lua.createState().doString('return 3 * 3')
                })

                expect(result).to.be.equal(9)
                expect(cdnRequests).to.have.lengthOf(1)
                expect(cdnRequests[0]).to.match(/^https:\/\/unpkg\.com\/wasmoon@[^/]+\/dist\/glue\.wasm$/)
            } finally {
                await page.close()
                await cleanup()
            }
        })
    })
})

/**
 * A single self contained HTML file, the only shape that works from `file:`: Chromium refuses to
 * load an ES module over that protocol, so the bundle is inlined. It is already a single chunk, and
 * its exported bindings are in scope of the inline module.
 */
async function writeInlinedPage() {
    const tempDir = await mkdtemp(join(tmpdir(), 'wasmoon-file-'))
    const bundle = await readFile(join(DIST_DIR, 'index.js'), 'utf8')

    const htmlFile = join(tempDir, 'page.html')
    await writeFile(
        htmlFile,
        `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script type="module">
${bundle}
window.__LuaRuntime = LuaRuntime
window.__ready = true
</script>
</body></html>`,
    )

    return { htmlFile, cleanup: () => rm(tempDir, { recursive: true, force: true }) }
}
