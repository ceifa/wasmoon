import { Lua, LuaReturn, LuaType, LUA_MULTRET, decorate } from './index.js'
import version from 'package-version'
import fs from 'node:fs'
import readline from 'node:readline'

const usage = `
usage: wasmoon [options] [script [args]]
Available options are:
  -e stat     execute string 'stat'
  -i          enter interactive mode after executing 'script'
  -l mod      require library 'mod' into global 'mod'
  -l g=mod    require library 'mod' into global 'g'
  -v          show version information
  -E          ignore environment variables
  -W          turn warnings on
  --          stop handling options
  -           stop handling options and execute stdin
`.trim()

const failUsage = (message) => {
    if (message) console.error(message)
    console.log(usage)
    process.exit(1)
}

function parseArgs(args) {
    const out = { executeSnippets: [], includeModules: [], forceInteractive: false, warnings: false, ignoreEnv: false, showVersion: false, scriptFile: null }
    let i = 0
    const next = (flag) => args[++i] ?? failUsage(`Missing argument after ${flag}`)

    for (; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--') {
            i++
            break
        }
        if (!arg.startsWith('-') || arg.length === 1) {
            out.scriptFile = arg
            i++
            break
        }
        switch (arg) {
            case '-v': out.showVersion = true; break
            case '-W': out.warnings = true; break
            case '-E': out.ignoreEnv = true; break
            case '-i': out.forceInteractive = true; break
            case '-e': out.executeSnippets.push(next('-e')); break
            case '-l': out.includeModules.push(next('-l')); break
            case '-': out.scriptFile = '-'; i++; break
            default: failUsage(`unrecognized option: '${arg}'`)
        }
        if (out.scriptFile === '-') break
    }

    return { ...out, scriptArgs: args.slice(i) }
}

const { executeSnippets, includeModules, ignoreEnv, forceInteractive, warnings, showVersion, scriptFile, scriptArgs } = parseArgs(process.argv.slice(2))
let inputFD = 0
if (process.stdin.isTTY) {
    try {
        inputFD = fs.openSync('/dev/tty', 'r')
    } catch {
        inputFD = 0
    }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, removeHistoryDuplicates: true, prompt: '> ' })
const lua = await Lua.load({
    env: ignoreEnv ? undefined : process.env,
    fs: 'node',
    stdin: () => {
        try {
            rl.pause()
            const buffer = Buffer.alloc(0xff)
            let content = ''
            let current = 0
            while (true) {
                const bytesRead = fs.readSync(inputFD, buffer, current, buffer.length - current)
                if (bytesRead <= 0) break
                const charcode = buffer[current++]
                if (charcode === 127) current = Math.max(0, current - 2)
                else if (charcode === 13) break
                content = buffer.subarray(0, current).toString('utf8')
                process.stdout.write('\x1b[2K\x1b[0G')
                process.stdout.write(content)
            }
            rl.resume()
            return content
        } catch (error) {
            console.error(error)
            return ''
        }
    },
})

const state = lua.createState()
const global = state.global
if (showVersion) {
    console.log(`wasmoon ${version} (${global.get('_VERSION')})`)
    process.exit(0)
}
if (warnings) lua.module.lua_warning(global.address, '@on', 0)

for (const module of includeModules) {
    let [name, target] = module.split('=')
    target ||= name
    const require = global.get('require')
    global.set(name, require(target))
}
for (const snippet of executeSnippets) await state.doString(snippet)

global.set('arg', decorate(scriptArgs, { proxy: false }))
if (scriptFile === '-') await state.doString(fs.readFileSync(0, 'utf-8'))
else if (scriptFile) await state.doFile(scriptFile)

if (process.stdin.isTTY && (forceInteractive || (!scriptFile && executeSnippets.length === 0))) {
    const load = (code) => {
        global.setTop(0)
        return lua.module.luaL_loadstring(global.address, code) === LuaReturn.Ok
    }

    console.log(`Welcome to Wasmoon ${version} (${global.get('_VERSION')})`)
    console.log('Type Lua code and press Enter to execute. Ctrl+C to exit.\n')
    rl.prompt()

    for await (const line of rl) {
        if (!load(`return ${line}`) && !load(line)) {
            console.log(global.getValue(-1, LuaType.String))
            rl.prompt()
            continue
        }

        const result = lua.module.lua_pcallk(global.address, 0, LUA_MULTRET, 0, 0, null)
        if (result === LuaReturn.Ok) {
            const count = global.getTop()
            if (count > 0) {
                const values = []
                for (let i = 1; i <= count; i++) values.push(global.indexToString(i))
                console.log(...values)
            }
        } else {
            console.log(global.getValue(-1, LuaType.String))
        }
        rl.prompt()
    }
} else if (!scriptFile) {
    await state.doString(fs.readFileSync(0, 'utf-8'))
}
