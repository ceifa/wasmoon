import { expect } from 'chai'
import { LuaMultiReturn, LuaRawResult, LuaReturn, LuaTypeExtension, decorate } from '../dist/index.js'
import { getLua, getState } from './utils.js'

describe('MultiReturn', () => {
    it('should push several lua values from one JS function', async () => {
        using state = await getState()
        state.set('divide', (a, b) => LuaMultiReturn.of(Math.floor(a / b), a % b))

        const result = await state.doString('local q, r = divide(7, 2) return ("%d,%d"):format(q, r)')

        expect(result).to.be.equal('3,1')
    })

    it('should report its length to lua', async () => {
        using state = await getState()
        state.set('three', () => LuaMultiReturn.of('a', 'b', 'c'))

        expect(await state.doString('return select("#", three())')).to.be.equal(3)
    })

    it('should be distinguishable from a plain array, which stays one table', async () => {
        using state = await getState({ objects: 'copy' })
        state.set('plain', () => ['a', 'b', 'c'])

        expect(await state.doString('return select("#", plain())')).to.be.equal(1)
        expect(await state.doString('return type(plain())')).to.be.equal('table')
    })

    it('should push nothing for an empty one', async () => {
        using state = await getState()
        state.set('none', () => LuaMultiReturn.of())

        expect(await state.doString('return select("#", none())')).to.be.equal(0)
    })
})

describe('RawResult', () => {
    it('should hand back values the function pushed itself', async () => {
        using state = await getState()
        state.set(
            'raw',
            decorate(
                (thread) => {
                    thread.pushValue('a')
                    thread.pushValue('b')
                    return new LuaRawResult(2)
                },
                { receiveThread: true },
            ),
        )

        expect(await state.doString('local x, y = raw() return x .. y')).to.be.equal('ab')
        expect(await state.doString('return select("#", raw())')).to.be.equal(2)
    })
})

describe('Decoration options', () => {
    it('self should bind the receiver and drop it from the arguments', async () => {
        using state = await getState()
        const counter = {
            n: 41,
            bump(by) {
                this.n += by ?? 1
                return this.n
            },
        }
        state.set('bump', decorate(counter.bump, { self: counter }))

        expect(await state.doString('return bump()')).to.be.equal(42)
        expect(await state.doString('return bump(8)')).to.be.equal(50)
        expect(counter.n).to.be.equal(50)
    })

    it('receiveThread should pass the calling thread as the first argument', async () => {
        using state = await getState()
        state.set(
            'grab',
            decorate((thread, ...args) => `${typeof thread.address}:${args.join(',')}`, { receiveThread: true }),
        )

        expect(await state.doString('return grab("a", "b")')).to.be.equal('number:a,b')
    })

    it('receiveArgsQuantity should pass the count instead of the arguments', async () => {
        using state = await getState()
        state.set(
            'count',
            decorate((quantity) => quantity, { receiveArgsQuantity: true }),
        )

        expect(await state.doString('return count(1, 2, 3)')).to.be.equal(3)
        expect(await state.doString('return count()')).to.be.equal(0)
    })
})

describe('Custom type extensions', () => {
    class Point {
        constructor(x) {
            this.x = x
        }
    }

    // A dedicated metatable name is the thing no built in provides, and what proves the custom
    // extension ran rather than the userdata one.
    class PointExtension extends LuaTypeExtension {
        constructor(state) {
            super(state, 'js_point')
            this.gcPointer = this.createGcFunction()

            if (state.module.luaL_newmetatable(state.address, this.name)) {
                const metatableIndex = state.module.lua_gettop(state.address)
                state.module.lua_pushcclosure(state.address, this.gcPointer, 0)
                state.module.lua_setfield(state.address, metatableIndex, '__gc')
                state.pushValue((point) => `Point(${point.x})`)
                state.module.lua_setfield(state.address, metatableIndex, '__tostring')
            }
            state.module.lua_pop(state.address, 1)
        }

        close() {
            this.state.module.emscripten.removeFunction(this.gcPointer)
        }

        pushValue(thread, decoration) {
            return decoration.target instanceof Point ? super.pushValue(thread, decoration) : false
        }
    }

    it('should take priority over the built in handling and round trip', async () => {
        using state = await getState()
        state.registerTypeExtension(6, new PointExtension(state))
        const point = new Point(9)
        state.set('pt', point)

        expect(await state.doString('return type(pt)')).to.be.equal('userdata')
        expect(await state.doString('return tostring(pt)')).to.be.equal('Point(9)')
        expect(state.get('pt')).to.be.equal(point)
    })

    it('should leave values it refuses to the built in handling', async () => {
        using state = await getState()
        state.registerTypeExtension(6, new PointExtension(state))
        state.set('other', { x: 1 })

        expect(await state.doString('return other.x')).to.be.equal(1)
    })
})

describe('Thread lifecycle', () => {
    it('resetThread should let a finished thread be loaded again', async () => {
        using state = await getState()
        const thread = state.newThread()
        thread.loadString('return 1')
        expect(await thread.run()).to.be.eql([1])

        thread.resetThread()
        thread.loadString('return 42')

        expect(await thread.run()).to.be.eql([42])
    })

    it('resetThread should surface the error that stopped the thread', async () => {
        // lua_resetthread reports the status the thread died with.
        using state = await getState()
        const thread = state.newThread()
        thread.loadString('error("boom")')
        await expect(thread.run()).to.eventually.be.rejectedWith('boom')

        expect(() => thread.resetThread()).to.throw('boom')
    })

    it('loadString name should set the chunk name used in errors', async () => {
        using state = await getState()
        const thread = state.newThread()
        thread.loadString('error("named")', { name: '@mychunk.lua' })

        await expect(thread.run()).to.eventually.be.rejectedWith('mychunk.lua:1: named')
    })

    it('onClose should fire once when the state closes', async () => {
        const lua = await getLua()
        const state = lua.createState()
        let closed = 0
        state.onClose(() => closed++)

        state.close()
        state.close()

        expect(closed).to.be.equal(1)
    })

    it('indexToString should render a value the way lua would', async () => {
        using state = await getState()
        state.pushValue(12)
        state.pushValue('hi')

        expect(state.indexToString(-2)).to.be.equal('12')
        expect(state.indexToString(-1)).to.be.equal('hi')

        state.pop(2)
    })

    it('indexToString should call __tostring when there is one', async () => {
        using state = await getState()
        state.set('thing', decorate({}, { metatable: { __tostring: () => 'rendered' } }))
        state.module.lua_getglobal(state.address, 'thing')

        expect(state.indexToString(-1)).to.be.equal('rendered')

        state.pop()
    })
})

// A lua_Integer is an i64, so pushValue converts a safe integer to a BigInt and anything outside
// that range becomes a float. These cover both ends of the range, and the raw bindings, which take
// the BigInt directly.
describe('Lua integer arguments', () => {
    const edges = [0, 1, -1, 2 ** 31, -(2 ** 31), 2 ** 32, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]

    it('should push every safe integer exactly, as an integer', async () => {
        using state = await getState()

        for (const value of edges) {
            state.set('value', value)

            expect(await state.doString('return math.type(value)'), `math.type of ${value}`).to.be.equal('integer')
            expect(await state.doString('return value'), `round trip of ${value}`).to.be.equal(value)
        }
    })

    it('should push negative zero as the integer zero, the way a bigint does', async () => {
        using state = await getState()
        state.set('value', -0)

        expect(await state.doString('return math.type(value)')).to.be.equal('integer')
        expect(await state.doString('return value == 0')).to.be.equal(true)
    })

    it('should take a raw table index as a bigint', async () => {
        using state = await getState()
        state.module.lua_createtable(state.address, 3, 0)

        for (const [index, text] of ['a', 'b', 'c'].entries()) {
            state.pushValue(text)
            state.module.lua_rawseti(state.address, -2, BigInt(index + 1))
        }
        state.module.lua_setglobal(state.address, 'letters')

        expect(await state.doString('return table.concat(letters, ",")')).to.be.equal('a,b,c')
    })

    it('should reach an index a double cannot hold exactly through a bigint', async () => {
        using state = await getState()
        const index = 2n ** 62n

        state.module.lua_createtable(state.address, 0, 1)
        state.pushValue('far')
        state.module.lua_rawseti(state.address, -2, index)
        state.module.lua_setglobal(state.address, 'sparse')

        expect(await state.doString('return sparse[4611686018427387904]')).to.be.equal('far')
    })
})

// A marshalled string goes on the wasm stack, which is 1MB and shared with the Lua calls made
// through it, so one longer than that has to be put on the heap instead.
describe('C string arguments', () => {
    const OVER_STACK = 1_500_000

    it('should marshal a name longer than the wasm stack', async () => {
        using state = await getState()
        const name = `long_${'n'.repeat(OVER_STACK)}`

        // lua_setglobal and lua_getglobal both take the name as a C string.
        state.set(name, 'reached')

        expect(state.get(name)).to.be.equal('reached')
    })

    it('should marshal a chunk longer than the wasm stack', async () => {
        using state = await getState()
        // luaL_loadstring takes the whole chunk as a C string, unlike doString which hands over a
        // pointer of its own.
        const script = `${'-- padding\n'.repeat(OVER_STACK / 10)}return 'compiled'`

        expect(state.module.luaL_loadstring(state.address, script)).to.be.equal(LuaReturn.Ok)
        expect(state.runSync()[0]).to.be.equal('compiled')
    })
})
