import { Lua } from '../dist/index.js'
import { fileURLToPath } from 'node:url'
import { readFile, glob } from 'node:fs/promises'

const lua = await Lua.load()
const testsPath = import.meta.resolve('../lua/testes')
const filePath = fileURLToPath(typeof testsPath === 'string' ? testsPath : await Promise.resolve(testsPath))

if (!lua.filesystem.analyzePath('/dev/full').exists) {
    const deviceMode = lua.filesystem.lookupPath('/dev/null').node.mode
    const fullDevice = lua.filesystem.makedev(64, 0)
    lua.filesystem.registerDevice(fullDevice, {
        open(stream) {
            stream.seekable = false
        },
        close() {},
        read() {
            return 0
        },
        write() {
            throw new lua.filesystem.ErrnoError(28)
        },
        llseek() {
            throw new lua.filesystem.ErrnoError(70)
        },
    })
    lua.filesystem.mkdev('/dev/full', deviceMode, fullDevice)
}

for await (const file of glob(`${filePath}/**/*.lua`)) {
    const relativeFile = file.replace(`${filePath}/`, '')
    lua.mountFile(relativeFile, await readFile(file))
}

const state = lua.createState()
lua.module.lua_warning(state.global.address, '@on', 0)
state.global.set('arg', ['lua', 'all.lua'])
state.global.set('_port', true)
state.global.getTable('os', (i) => {
    state.global.setField(i, 'setlocale', (locale) => {
        return locale && locale !== 'C' ? false : 'C'
    })
})
state.doFileSync('all.lua')
