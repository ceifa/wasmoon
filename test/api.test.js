import { expect } from 'chai'
import { LuaMultiReturn, LuaRawResult, LuaTypeExtension, decorate } from '../dist/index.js'
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

            if (state.lua.luaL_newmetatable(state.address, this.name)) {
                const metatableIndex = state.lua.lua_gettop(state.address)
                state.lua.lua_pushcclosure(state.address, this.gcPointer, 0)
                state.lua.lua_setfield(state.address, metatableIndex, '__gc')
                state.pushValue((point) => `Point(${point.x})`)
                state.lua.lua_setfield(state.address, metatableIndex, '__tostring')
            }
            state.lua.lua_pop(state.address, 1)
        }

        close() {
            this.state.lua._emscripten.removeFunction(this.gcPointer)
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
        state.lua.lua_getglobal(state.address, 'thing')

        expect(state.indexToString(-1)).to.be.equal('rendered')

        state.pop()
    })
})
