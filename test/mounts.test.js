import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'chai'
import { LuaRuntime } from '../dist/index.js'
import { readFileFromLua, useTempDirs } from './utils.js'

describe('Mounts', () => {
    const createTempDir = useTempDirs('mounts')
    let hostDir
    let outsideDir

    beforeEach(() => {
        hostDir = createTempDir()
        outsideDir = createTempDir()
        writeFileSync(join(hostDir, 'inside.txt'), 'mounted content')
        writeFileSync(join(outsideDir, 'outside.txt'), 'should stay unreachable')
    })

    it('the in-memory filesystem alone should reach nothing on the host', async () => {
        const lua = await LuaRuntime.load()
        using state = lua.createState()

        expect(readFileFromLua(state, join(hostDir, 'inside.txt'))).to.be.equal('BLOCKED')
    })

    it('a mount should expose the host directory at the given path', async () => {
        const lua = await LuaRuntime.load({ mounts: { '/scripts': hostDir } })
        using state = lua.createState()

        expect(readFileFromLua(state, '/scripts/inside.txt')).to.be.equal('mounted content')
    })

    it('a mount should leave the rest of the host unreachable', async () => {
        const lua = await LuaRuntime.load({ mounts: { '/scripts': hostDir } })
        using state = lua.createState()

        expect(readFileFromLua(state, join(outsideDir, 'outside.txt'))).to.be.equal('BLOCKED')
        // Not even the host path the mount points at, since only the mount point leads there.
        expect(readFileFromLua(state, join(hostDir, 'inside.txt'))).to.be.equal('BLOCKED')
    })

    it('a write through a mount should land on the host', async () => {
        const lua = await LuaRuntime.load({ mounts: { '/scripts': hostDir } })
        using state = lua.createState()

        state.doStringSync(`
            local f = io.open("/scripts/written.txt", "w")
            f:write("from lua")
            f:close()
        `)

        expect(readFileSync(join(hostDir, 'written.txt'), 'utf8')).to.be.equal('from lua')
    })

    it('several mounts should coexist with files written to memory', async () => {
        const other = createTempDir()
        writeFileSync(join(other, 'other.txt'), 'the other one')

        const lua = await LuaRuntime.load({ mounts: { '/a': hostDir, '/b/deeper': other } })
        using state = lua.createState()
        lua.writeFile('/virtual/only.txt', 'in memory')

        expect(readFileFromLua(state, '/a/inside.txt')).to.be.equal('mounted content')
        expect(readFileFromLua(state, '/b/deeper/other.txt')).to.be.equal('the other one')
        expect(readFileFromLua(state, '/virtual/only.txt')).to.be.equal('in memory')
    })

    it('a relative host path should resolve against the process working directory', async () => {
        const lua = await LuaRuntime.load({ mounts: { '/here': '.' } })
        using state = lua.createState()

        expect(readFileFromLua(state, '/here/package.json')).to.match(/"name": "wasmoon"/)
    })

    it('require should find a module inside a mount', async () => {
        mkdirSync(join(hostDir, 'lib'), { recursive: true })
        writeFileSync(join(hostDir, 'lib', 'mymod.lua'), 'return { value = 7 }')

        const lua = await LuaRuntime.load({ mounts: { '/scripts': hostDir } })
        using state = lua.createState({ inject: true })

        expect(
            state.doStringSync(`
            package.path = "/scripts/lib/?.lua;" .. package.path
            return require("mymod").value
        `),
        ).to.be.equal(7)
    })

    it('mounting after loading should expose the directory', async () => {
        const lua = await LuaRuntime.load()
        using state = lua.createState()

        expect(readFileFromLua(state, '/late/inside.txt')).to.be.equal('BLOCKED')

        lua.mount('/late', hostDir)

        expect(readFileFromLua(state, '/late/inside.txt')).to.be.equal('mounted content')
    })

    it('unmounting should make the directory unreachable again, and free the mount point', async () => {
        const lua = await LuaRuntime.load({ mounts: { '/scripts': hostDir } })
        using state = lua.createState()

        lua.unmount('/scripts')

        expect(readFileFromLua(state, '/scripts/inside.txt')).to.be.equal('BLOCKED')

        // The mount point is no longer taken, so the same path can be mounted again.
        lua.mount('/scripts', outsideDir)
        expect(readFileFromLua(state, '/scripts/outside.txt')).to.be.equal('should stay unreachable')
    })

    describe('validation', () => {
        // Each case is the same call with a different mounts object, so they are listed rather than
        // written out: [what is wrong, mounts, the message it has to be reported with].
        const cases = [
            ['a host directory that does not exist', () => ({ '/scripts': join(hostDir, 'missing') }), /could not be read/],
            ['a host path that is a file', () => ({ '/scripts': join(hostDir, 'inside.txt') }), /is not a directory/],
            ['a mount point that is not absolute', () => ({ scripts: hostDir }), /has to be an absolute path below the root/],
            ['the root as a mount point', () => ({ '/': hostDir }), /has to be an absolute path below the root/],
            ['an empty segment in the mount point', () => ({ '//scripts': hostDir }), /has to be an absolute path below the root/],
            ['a mount point that is not normalized', () => ({ '/scripts/../etc': hostDir }), /has to be a normalized path/],
            ['nested mount points', () => ({ '/scripts': hostDir, '/scripts/inner': outsideDir }), /it overlaps the mount point/],
            ['the same mount point twice', () => ({ '/scripts': hostDir, '/scripts/': outsideDir }), /it overlaps the mount point/],
            ['a host path starting with ~', () => ({ '/home': '~/wasmoon' }), /'~' is not expanded/],
        ]

        for (const [what, mounts, message] of cases) {
            it(`${what} should throw`, async () => {
                await expect(LuaRuntime.load({ mounts: mounts() })).to.eventually.be.rejectedWith(message)
            })
        }

        it('a mount that overlaps one already made should throw', async () => {
            const lua = await LuaRuntime.load({ mounts: { '/scripts': hostDir } })

            expect(() => lua.mount('/scripts/inner', outsideDir)).to.throw(/it overlaps the mount point '\/scripts'/)
        })
    })
})
