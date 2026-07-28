import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'chai'
import { chromium } from 'playwright'

const DIST_DIR = new URL('../dist', import.meta.url).pathname

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

    const server = createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost`)

        if (url.pathname === '/' || url.pathname === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(testPage)
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
    let port, browser, context

    before(async function () {
        this.timeout(30_000)
        ;({ port } = await startServer())
        browser = await chromium.launch()
        context = await browser.newContext()
    })

    async function runInBrowser(code) {
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', (err) => errors.push(err))

        try {
            await page.goto(`http://127.0.0.1:${port}/`)
            await page.waitForFunction(() => window.__ready === true, null, { timeout: 15_000 })

            const result = await page.evaluate(async (c) => {
                return await window.__runTest(c)
            }, code)

            if (errors.length > 0) {
                throw errors[0]
            }
            return result
        } finally {
            await page.close()
        }
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
            lua.mountFile('mymodule.lua', 'return 42')
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
})
