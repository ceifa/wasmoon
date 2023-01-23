import { LuaFactory } from '../dist/index.js'
import { fileURLToPath } from 'node:url'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

async function* walk(dir) {
    const dirents = await readdir(dir, { withFileTypes: true })
    for (const dirent of dirents) {
        const res = resolve(dir, dirent.name)
        if (dirent.isDirectory()) {
            yield* walk(res)
        } else {
            yield res
        }
    }
}

const disabledtests = ['main.lua', 'strings.lua', 'literals.lua', 'files.lua']

const factory = new LuaFactory()
const filePath = fileURLToPath(await import.meta.resolve('../lua/testes'))

for await (const file of walk(filePath)) {
    const relativeFile = file.replace(`${filePath}/`, '')
    if (disabledtests.includes(relativeFile)) {
        await factory.mountFile(relativeFile, 'return 0')
    } else {
        await factory.mountFile(relativeFile, await readFile(file))
    }
}

const lua = await factory.createEngine()
const luamodule = await factory.getLuaModule()
luamodule.lua_warning(lua.global.address, '@on', 0)
lua.global.set('arg', ['lua', 'all.lua'])
lua.doFileSync('all.lua')
