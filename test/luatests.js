import { LuaFactory } from '../dist/index.js'
import { fileURLToPath } from 'node:url'
import { readFile, glob } from 'node:fs/promises'

const factory = new LuaFactory()
const testsPath = import.meta.resolve('../lua/testes')
const filePath = fileURLToPath(typeof testsPath === 'string' ? testsPath : await Promise.resolve(testsPath))

for await (const file of glob(`${filePath}/**/*.lua`)) {
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
