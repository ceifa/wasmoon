import { LuaRuntime } from './index.js'

export * from './index.js'

/** The runtime the page's Lua runs on, loaded once whoever imports this first. */
export const runtime = await LuaRuntime.load()
/** The state every `<script type="application/lua">` runs in, with every global `inject` offers. */
export const state = runtime.createState({ inject: true })

// Where fengari-web scripts find the page, as a global and through `require "js"`.
state.set('js', { global: globalThis })
state.doStringSync('package.loaded.js = js')

// Parameters and case aside, the two types fengari-web runs.
const LUA_TYPE = /^\s*(?:application|text)\/lua\s*(?:;|$)/i

const started = new WeakSet<HTMLScriptElement>()
// Settles once the last ordered script has its code, so they start in document order the way
// classic scripts do while their fetches still run in parallel.
let previous: Promise<unknown> = Promise.resolve()

function start(script: HTMLScriptElement): void {
    if (started.has(script) || !LUA_TYPE.test(script.type)) {
        return
    }
    started.add(script)

    const source = script.src ? fetchSource(script) : Promise.resolve(script.text)
    // As on a classic script, only a src one marked async may run out of order. The attribute
    // rather than the property, which a browser leaves true on a parsed script it does not run.
    const ordered = !(script.src && script.hasAttribute('async'))
    const ready = ordered ? Promise.allSettled([source, previous]).then(() => source) : source
    if (ordered) {
        previous = ready.catch(() => {})
    }

    const name = script.src ? `@${script.src}` : script.id ? `=${script.id}` : undefined
    ready.then(
        (code) => state.doString(code, { name }).catch(reportError),
        () => script.dispatchEvent(new Event('error')),
    )
}

async function fetchSource(script: HTMLScriptElement): Promise<string> {
    const credentials = script.crossOrigin === 'use-credentials' ? 'include' : 'same-origin'
    const response = await fetch(script.src, { credentials, integrity: script.integrity })
    if (!response.ok) {
        throw new Error(`${script.src} responded ${response.status}`)
    }
    return response.text()
}

function startWithin(node: Node): void {
    if (node instanceof HTMLScriptElement) {
        start(node)
    } else if (node instanceof Element) {
        node.querySelectorAll('script').forEach(start)
    }
}

if (typeof document !== 'undefined') {
    new MutationObserver((records) => {
        for (const record of records) {
            record.addedNodes.forEach(startWithin)
        }
    }).observe(document, { childList: true, subtree: true })
    document.querySelectorAll('script').forEach(start)
}
