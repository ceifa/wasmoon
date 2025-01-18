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

const factory = new LuaFactory()
const testsPath = import.meta.resolve('../lua/testes')
const filePath = fileURLToPath(typeof testsPath === 'string' ? testsPath : await Promise.resolve(testsPath))

for await (const file of walk(filePath)) {
    const relativeFile = file.replace(`${filePath}/`, '')
    await factory.mountFile(relativeFile, await readFile(file))
}

const lua = await factory.createEngine()
const luamodule = await factory.getLuaModule()
luamodule.lua_warning(lua.global.address, '@on', 0)
lua.global.set('arg', ['lua', 'all.lua'])
lua.global.set('_port', true)
lua.global.getTable('os', (i) => {
    lua.global.setField(i, 'setlocale', (locale) => {
        return locale && locale !== 'C' ? false : 'C'
    })
})
lua.doFileSync('all.lua')
