import { expect } from 'chai'
import { LuaMultiReturn, LuaReturn, LuaType, copy, raw } from '../dist/index.js'
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

describe('raw', () => {
    it('should hand back the values the function pushed itself', async () => {
        using state = await getState()
        state.set(
            'pair',
            raw((thread) => {
                thread.pushValue('a')
                thread.pushValue('b')
                return 2
            }),
        )

        expect(await state.doString('local x, y = pair() return x .. y')).to.be.equal('ab')
        expect(await state.doString('return select("#", pair())')).to.be.equal(2)
    })

    it('should receive the calling thread and the argument count, with the arguments still on the stack', async () => {
        using state = await getState()
        state.set(
            'describe',
            raw((thread, argCount) => {
                const args = []
                for (let i = 1; i <= argCount; i++) {
                    args.push(thread.getValue(i))
                }
                thread.pushValue(`${typeof thread.address}:${argCount}:${args.join(',')}`)
                return 1
            }),
        )

        expect(await state.doString('return describe("a", "b")')).to.be.equal('number:2:a,b')
        expect(await state.doString('return describe()')).to.be.equal('number:0:')
    })

    it('should return its own arguments without marshalling them', async () => {
        using state = await getState()
        state.set(
            'swap',
            raw((thread) => {
                thread.module.lua_rotate(thread.address, 1, 1)
                return 2
            }),
        )

        // A table that went through JS would come back as another table.
        expect(await state.doString('local t = {} local a, b = swap(1, t) return a == t and b == 1')).to.be.equal(true)
    })

    it('should raise a JS error it throws as a Lua error', async () => {
        using state = await getState()
        state.set(
            'fail',
            raw(() => {
                throw new Error('raw failure')
            }),
        )

        expect(await state.doString('local ok, err = pcall(fail) return tostring(err)')).to.be.equal('raw failure')
    })

    it('should refuse a result count that is not one', async () => {
        using state = await getState()
        state.set(
            'forgot',
            raw(() => undefined),
        )

        await expect(state.doString('forgot()')).to.eventually.be.rejectedWith('number of values it pushed')
    })

    it('should only wrap a function', () => {
        expect(() => raw({})).to.throw('raw expects a function')
    })
})

describe('Reference bookkeeping', () => {
    it('reuses holes below a live high index without exposing free-list links', async () => {
        const { module } = await getLua()
        const refs = Array.from({ length: 2048 }, () => module.ref({}))
        const anchor = Symbol('anchor')
        const high = module.ref(anchor)
        for (const ref of refs) {
            module.unref(ref)
            expect(module.getRef(ref)).to.equal(undefined)
        }
        for (const index of [-1, 0, high + 1]) {
            module.unref(index)
            expect(module.getRef(index)).to.equal(undefined)
        }
        const value = {}
        const reused = module.ref(value)
        expect(refs).to.include(reused)
        expect(module.getRef(high)).to.equal(anchor)
        expect(module.getRefIndex(anchor)).to.equal(high)
        module.unref(high)
        expect(module.getRef(reused)).to.equal(value)
        module.unref(reused)
    })

    it('preserves live indices and reuses released slots after a large batch', async () => {
        const { module } = await getLua()
        const values = Array.from({ length: 2048 }, () => ({}))
        const refs = values.map((value) => module.ref(value))
        // Keep several low indices alive, including a value held twice, while the tail shrinks.
        module.ref(values[16])
        for (let i = 0; i < refs.length; i++) {
            if (i !== 0 && i !== 32) module.unref(refs[i])
        }
        for (const i of [0, 16, 32]) {
            expect(module.getRef(refs[i])).to.equal(values[i])
            expect(module.getRefIndex(values[i])).to.equal(refs[i])
        }
        const replacements = values.map(() => ({}))
        const next = replacements.map((value) => module.ref(value))
        expect(new Set(next).size).to.equal(next.length)
        for (const i of [0, 16, 32]) expect(next).not.to.include(refs[i])
        for (let i = 0; i < next.length; i++) expect(module.getRef(next[i])).to.equal(replacements[i])
        // Descending release also exercises shrinking while the free list has holes.
        for (let i = next.length - 1; i >= 0; i--) module.unref(next[i])
        for (const i of [0, 16, 32]) module.unref(refs[i])
        const remaining = []
        module.printRefs((index) => remaining.push(index))
        expect(remaining).to.deep.equal([])
    })

    it('failed registration leaves live references and reusable slots intact', async () => {
        const { module } = await getLua()
        const live = {}
        const first = module.ref(live)
        const reusable = module.ref({})
        module.unref(reusable)

        for (const value of [undefined, null, true, 1, 'not a weak key', Symbol.for('registered')]) {
            expect(() => module.ref(value)).to.throw(TypeError)
        }

        const references = []
        module.printRefs((index, value) => references.push([index, value]))
        expect(references).to.deep.equal([[first, live]])
        expect(module.ref({})).to.equal(reusable)
        expect(module.getRef(first)).to.equal(live)
    })

    it('reuses a slot only after its final reference is released', async () => {
        const { module } = await getLua()
        const value = {}
        const reference = module.ref(value)
        expect(module.ref(value)).to.equal(reference)
        module.unref(reference)
        expect(module.getRef(reference)).to.equal(value)
        module.unref(reference)
        expect(module.getRefIndex(value)).to.equal(undefined)
        module.unref(reference)
        const reused = module.ref({})
        expect(reused).to.equal(reference)
        expect(module.ref({})).not.to.equal(reused)
    })
})

describe('Function identity', () => {
    it('should push the same function as the same Lua value', async () => {
        using state = await getState()
        const fn = () => 1
        state.set('a', fn)
        state.set('b', fn)
        state.set('c', copy(fn))

        expect(await state.doString('return a == b and b == c')).to.be.equal(true)
    })

    it('should push the same raw wrapper as the same Lua value, and another wrapper as another', async () => {
        using state = await getState()
        const count = (_thread, argCount) => {
            _thread.pushValue(argCount)
            return 1
        }
        const wrapped = raw(count)
        state.set('raw1', wrapped)
        state.set('raw2', wrapped)
        state.set('other', raw(count))

        expect(await state.doString('return raw1 == raw2')).to.be.equal(true)
        expect(await state.doString('return raw1 ~= other')).to.be.equal(true)
        expect(await state.doString('return raw1(1, 2) + other(1, 2, 3)')).to.be.equal(5)
    })

    it('should hand out the same Lua value for the same proxied method', async () => {
        using state = await getState()
        state.set('obj', {
            n: 0,
            bump() {
                this.n++
            },
        })

        expect(await state.doString('return obj.bump == obj.bump')).to.be.equal(true)
        await state.doString('for _ = 1, 3 do obj:bump() end')
        expect(state.get('obj').n).to.be.equal(3)
    })

    it('a proxied method should reach its object called with a dot or with a colon', async () => {
        using state = await getState()
        const counter = {
            n: 41,
            bump(by) {
                this.n += by ?? 1
                return this.n
            },
        }
        state.set('counter', counter)

        expect(await state.doString('return counter.bump()')).to.be.equal(42)
        expect(await state.doString('return counter:bump(8)')).to.be.equal(50)
        expect(await state.doString('local bump = counter.bump return bump(1)')).to.be.equal(51)
        expect(counter.n).to.be.equal(51)
    })
})

describe('defineType', () => {
    class Point {
        constructor(x) {
            this.x = x
        }
    }

    const definePoint = (state) =>
        state.defineType({
            name: 'js_point',
            match: (value) => value instanceof Point,
            metatable: { __tostring: (point) => `Point(${point.x})`, __index: { kind: 'point' } },
        })

    it('should take what it matches ahead of the built in handling, and round trip it', async () => {
        using state = await getState()
        definePoint(state)
        const point = new Point(9)
        state.set('pt', point)

        expect(await state.doString('return type(pt)')).to.be.equal('userdata')
        expect(await state.doString('return tostring(pt)')).to.be.equal('Point(9)')
        expect(await state.doString('return pt.kind')).to.be.equal('point')
        expect(state.get('pt')).to.be.equal(point)
    })

    it('should get a protected metatable and release the reference once collected', async () => {
        using state = await getState()
        definePoint(state)
        const point = new Point(1)
        state.set('pt', point)

        expect(await state.doString('return getmetatable(pt)')).to.be.equal('protected metatable')
        expect(state.module.getRefIndex(point)).to.not.be.undefined

        await state.doString('pt = nil collectgarbage() collectgarbage()')
        expect(state.module.getRefIndex(point)).to.be.undefined
    })

    it('should leave values it does not match to the built in handling', async () => {
        using state = await getState()
        definePoint(state)
        state.set('other', { x: 1 })

        expect(await state.doString('return other.x')).to.be.equal(1)
    })

    it('should take its values wherever they come from', async () => {
        using state = await getState({ objects: 'copy' })
        definePoint(state)
        state.set('make', (x) => new Point(x))
        state.set('nested', { inner: new Point(3) })

        expect(await state.doString('return tostring(make(7))')).to.be.equal('Point(7)')
        expect(await state.doString('return tostring(nested.inner)')).to.be.equal('Point(3)')
    })

    it('should consult the most recently defined type first', async () => {
        using state = await getState()
        state.defineType({ name: 'any_point', match: (value) => value instanceof Point, metatable: { __tostring: () => 'any' } })
        state.defineType({
            name: 'origin',
            match: (value) => value instanceof Point && value.x === 0,
            metatable: { __tostring: () => 'origin' },
        })
        state.set('zero', new Point(0))
        state.set('one', new Point(1))

        expect(await state.doString('return tostring(zero) .. "," .. tostring(one)')).to.be.equal('origin,any')
    })

    it('should refuse a name that is taken', async () => {
        using state = await getState()
        definePoint(state)

        expect(() => definePoint(state)).to.throw("the name 'js_point' is already taken")
        expect(() => state.defineType({ name: 'js_proxy', match: () => false })).to.throw("the name 'js_proxy' is already taken")
    })

    it('should need a name and a match', async () => {
        using state = await getState()

        expect(() => state.defineType({ match: () => true })).to.throw('defineType needs a name')
        expect(() => state.defineType({ name: 'nameless' })).to.throw('defineType needs a match function')
    })

    describe('toLua and fromLua', () => {
        const defineMap = (state) =>
            state.defineType({
                name: 'Map',
                match: (value) => value instanceof Map,
                toLua: (map) => copy(Object.fromEntries(map)),
                fromLua: (table) => new Map(Object.entries(table)),
            })

        it('should push what toLua returns in place of the value', async () => {
            using state = await getState()
            defineMap(state)
            state.set('map', new Map([['answer', 42]]))

            expect(await state.doString('return type(map)')).to.be.equal('table')
            expect(await state.doString('return map.answer')).to.be.equal(42)
        })

        it('should read a table toLua produced back through fromLua', async () => {
            using state = await getState()
            defineMap(state)
            state.set('map', new Map([['answer', 42]]))

            const back = await state.doString('map.added = true return map')

            expect(back).to.be.an.instanceOf(Map)
            expect([...back.entries()].sort()).to.be.eql([
                ['added', true],
                ['answer', 42],
            ])
        })

        it('should read a table Lua named after the type through fromLua', async () => {
            using state = await getState()
            defineMap(state)

            const made = await state.doString('return setmetatable({ lua = "made" }, { __name = "Map" })')

            expect(made).to.be.an.instanceOf(Map)
            expect(made.get('lua')).to.be.equal('made')
        })

        it('should leave a table named after a reference type as a table', async () => {
            using state = await getState()
            state.defineType({ name: 'js_point', match: (value) => value instanceof Point })

            // Only the metatable the state created marks a reference box, never a name.
            expect(await state.doString('return setmetatable({ x = 1 }, { __name = "js_point" })')).to.be.eql({ x: 1 })
            expect(await state.doString('return setmetatable({ x = 1 }, { __name = "js_proxy" })')).to.be.eql({ x: 1 })
        })

        it('should hand the JS value to the metamethods of a converted type', async () => {
            using state = await getState()
            state.defineType({
                name: 'Set',
                match: (value) => value instanceof Set,
                toLua: (set) => copy([...set]),
                fromLua: (items) => new Set(items),
                metatable: { __tostring: (set) => `Set of ${set.size}`, __len: (set) => set.size * 10 },
            })
            state.set('set', new Set(['a', 'b']))

            expect(await state.doString('return tostring(set)')).to.be.equal('Set of 2')
            expect(await state.doString('return #set')).to.be.equal(20)
            expect(await state.doString('return set[1]')).to.be.equal('a')
        })

        it('should decline a value when toLua returns it unchanged', async () => {
            using state = await getState()
            state.defineType({ name: 'passthrough', match: (value) => value instanceof Point, toLua: (value) => value })
            state.set('pt', new Point(4))

            // Fell through to the proxy, as if the type had not matched.
            expect(await state.doString('return pt.x')).to.be.equal(4)
        })

        it('should convert to a primitive, which has no type to read back', async () => {
            using state = await getState()
            state.defineType({ name: 'Date', match: (value) => value instanceof Date, toLua: (date) => date.getTime() })
            state.set('epoch', new Date(86_400_000))

            expect(await state.doString('return math.type(epoch)')).to.be.equal('integer')
            expect(await state.doString('return epoch')).to.be.equal(86_400_000)
        })
    })
})

describe('defineClass', () => {
    class Vector {
        static unit = 1
        static zero() {
            return new Vector(0, 0)
        }

        constructor(x, y) {
            this.x = x
            this.y = y
        }

        get length() {
            return Math.hypot(this.x, this.y)
        }

        add(other) {
            return new Vector(this.x + other.x, this.y + other.y)
        }

        describe() {
            return `a vector of ${this.x}, ${this.y}`
        }
    }

    class Vector3 extends Vector {
        constructor(x, y, z) {
            super(x, y)
            this.z = z
        }

        describe() {
            return `${super.describe()}, ${this.z}`
        }
    }

    const getVectorState = async (options) => {
        const state = await getState()
        state.defineClass(Vector, options)
        state.set('Vector', Vector)
        return state
    }

    it('should construct the class when it is called, or through new', async () => {
        using state = await getVectorState()

        expect(await state.doString('return Vector(3, 4)')).to.be.an.instanceOf(Vector)
        expect(await state.doString('return Vector.new(3, 4).x')).to.be.equal(3)
        expect(await state.doString('return Vector.new == Vector.new')).to.be.equal(true)
    })

    it('should call methods with a colon, and read fields and accessors', async () => {
        using state = await getVectorState()

        expect(await state.doString('local v = Vector(3, 4) return v:add(v).length')).to.be.equal(10)
        expect(await state.doString('return Vector(1, 2):describe()')).to.be.equal('a vector of 1, 2')
    })

    it('should write fields', async () => {
        using state = await getVectorState()
        const vector = new Vector(1, 2)
        state.set('v', vector)

        await state.doString('v.x = 10')

        expect(vector.x).to.be.equal(10)
    })

    it('should not guess the receiver of a method called with a dot', async () => {
        using state = await getVectorState()

        // The vector is taken for the receiver, which leaves `add` without its argument.
        await expect(state.doString('local v = Vector(3, 4) return v.add(v)')).to.eventually.be.rejectedWith(
            'Cannot read properties of undefined',
        )
        await expect(state.doString('local v = Vector(3, 4) return v.describe()')).to.eventually.be.rejectedWith(
            "bad argument #1 to 'describe' (Vector expected), call it as object:describe(...)",
        )
        // The receiver is an argument like any other, so passing it by hand is the same call.
        expect(await state.doString('local v = Vector(3, 4) return v.describe(v)')).to.be.equal('a vector of 3, 4')
        expect(await state.doString('local v = Vector(3, 4) return v:add(v):add(v).x')).to.be.equal(9)
    })

    it('should share one function per method between the instances', async () => {
        using state = await getVectorState()

        expect(await state.doString('return Vector(1, 2).add == Vector(3, 4).add')).to.be.equal(true)
    })

    it('should name the instances after the class', async () => {
        using state = await getVectorState()

        expect(await state.doString('return type(Vector(1, 2))')).to.be.equal('userdata')
        expect(await state.doString('return tostring(Vector(1, 2))')).to.match(/^Vector: 0x/)
        expect(await state.doString('return tostring(Vector)')).to.be.equal('class Vector')
        await expect(state.doString('return Vector(1, 2) + 1')).to.eventually.be.rejectedWith(
            'attempt to perform arithmetic on a Vector value',
        )
    })

    it('should read an instance back as itself', async () => {
        using state = await getVectorState()
        const vector = new Vector(1, 2)
        state.set('v', vector)

        expect(state.get('v')).to.be.equal(vector)
        expect(await state.doString('return v == v')).to.be.equal(true)
        expect(state.get('Vector')).to.be.equal(Vector)
    })

    it('should reach the static members the class declares, and nothing of Function', async () => {
        using state = await getVectorState()

        expect(await state.doString('return Vector.zero().x')).to.be.equal(0)
        expect(await state.doString('return Vector.unit')).to.be.equal(1)
        expect(await state.doString('return Vector.zero == Vector.zero')).to.be.equal(true)
        expect(await state.doString('return Vector.prototype == nil and Vector.bind == nil and Vector.call == nil')).to.be.equal(true)
    })

    it('should use the nearest defined class for a subclass, and the override it brings', async () => {
        using state = await getVectorState()
        state.set('v3', new Vector3(1, 2, 3))

        expect(await state.doString('return tostring(v3)')).to.match(/^Vector: 0x/)
        expect(await state.doString('return v3:describe()')).to.be.equal('a vector of 1, 2, 3')
        expect(await state.doString('return v3.z')).to.be.equal(3)
    })

    it('should prefer the most derived class that was defined', async () => {
        using state = await getVectorState()
        state.defineClass(Vector3)
        state.set('v2', new Vector(1, 2))
        state.set('v3', new Vector3(1, 2, 3))

        expect(await state.doString('return tostring(v2)')).to.match(/^Vector: 0x/)
        expect(await state.doString('return tostring(v3)')).to.match(/^Vector3: 0x/)
    })

    it('should take instances wherever they come from, whatever the objects option', async () => {
        using state = await getState({ objects: 'copy' })
        state.defineClass(Vector)
        state.set('data', { position: new Vector(5, 6), plain: { nested: true } })

        expect(await state.doString('return type(data)')).to.be.equal('table')
        expect(await state.doString('return type(data.plain)')).to.be.equal('table')
        expect(await state.doString('return data.position:describe()')).to.be.equal('a vector of 5, 6')
    })

    describe('members', () => {
        it('should make only the listed members reachable', async () => {
            using state = await getVectorState({ members: ['x', 'add'] })

            expect(await state.doString('local v = Vector(3, 4) return v:add(v).x')).to.be.equal(6)
            expect(await state.doString('local v = Vector(3, 4) return v.y == nil and v.describe == nil and v.length == nil')).to.be.equal(
                true,
            )
            expect(await state.doString('return Vector(3, 4).constructor == nil')).to.be.equal(true)
        })

        it('should refuse to write anything else', async () => {
            using state = await getVectorState({ members: ['x', 'add'] })
            const vector = new Vector(1, 2)
            state.set('v', vector)

            await state.doString('v.x = 5')
            await expect(state.doString('v.y = 5')).to.eventually.be.rejectedWith("cannot set 'y' on a Vector")
            await expect(state.doString('v[1] = 5')).to.eventually.be.rejectedWith("cannot set '1' on a Vector")

            expect(vector).to.be.eql(new Vector(5, 2))
        })

        it('statics should make only the listed static members reachable', async () => {
            using state = await getVectorState({ statics: ['zero'] })

            expect(await state.doString('return Vector.zero().x')).to.be.equal(0)
            expect(await state.doString('return Vector.unit == nil')).to.be.equal(true)
            expect(await state.doString('return Vector(1, 2).x')).to.be.equal(1)
        })
    })

    describe('options', () => {
        it('name should name the metatable', async () => {
            using state = await getVectorState({ name: 'Vec2' })

            expect(await state.doString('return tostring(Vector(1, 2))')).to.match(/^Vec2: 0x/)
            expect(await state.doString('return tostring(Vector)')).to.be.equal('class Vec2')
        })

        it('metamethods should be called with the instance first', async () => {
            using state = await getVectorState({
                metamethods: {
                    __tostring: (vector) => `(${vector.x}, ${vector.y})`,
                    __add: (a, b) => a.add(b),
                    __eq: (a, b) => a.x === b.x && a.y === b.y,
                    __len: () => 2,
                },
            })

            expect(await state.doString('return tostring(Vector(1, 2) + Vector(3, 4))')).to.be.equal('(4, 6)')
            expect(await state.doString('return Vector(1, 2) == Vector(1, 2)')).to.be.equal(true)
            expect(await state.doString('return #Vector(1, 2)')).to.be.equal(2)
        })

        it('should refuse to replace the metamethods the reference depends on', async () => {
            using state = await getState()

            expect(() => state.defineClass(Vector, { metamethods: { __gc: () => undefined } })).to.throw('defineClass cannot replace __gc')
        })
    })

    it('should refuse a class that is already defined, a name that is taken, and what is not a class', async () => {
        using state = await getVectorState()

        expect(() => state.defineClass(Vector)).to.throw("the class 'Vector' is already defined")
        expect(() => state.defineClass(class Vector {})).to.throw("the name 'Vector' is already taken")
        expect(() => state.defineClass(class {})).to.throw('needs a name for an anonymous class')
        expect(() => state.defineClass(() => undefined)).to.throw('defineClass expects a class')
        expect(() => state.defineClass({})).to.throw('defineClass expects a class')
    })

    it('should index an Array subclass from 1', async () => {
        using state = await getState()
        class Stack extends Array {
            peek() {
                return this.at(-1)
            }
        }
        state.defineClass(Stack)
        state.set('stack', Stack.from(['a', 'b', 'c']))

        expect(await state.doString('return stack[1] .. stack:peek()')).to.be.equal('ac')
        await state.doString('stack[4] = "d"')
        expect(state.get('stack')).to.have.lengthOf(4)
    })

    it('should release an instance once Lua has collected it', async () => {
        using state = await getVectorState()
        const vector = new Vector(1, 2)
        state.set('v', vector)
        expect(state.module.getRefIndex(vector)).to.not.be.undefined

        await state.doString('v = nil collectgarbage() collectgarbage()')

        expect(state.module.getRefIndex(vector)).to.be.undefined
    })

    it('should work without the standard libraries', async () => {
        using state = await getState({ libs: false, inject: false })
        state.defineClass(Vector)
        state.set('Vector', Vector)

        expect(await state.doString('return Vector(3, 4):add(Vector(1, 1)).x')).to.be.equal(4)
    })
})

describe('Thread lifecycle', () => {
    it('pushValue of the main thread should land on the pushing stack', async () => {
        using state = await getState()
        const thread = state.newThread()
        const stateTop = state.getTop()

        thread.pushValue(state)

        expect(thread.getTop()).to.be.equal(1)
        expect(state.getTop()).to.be.equal(stateTop)
        expect(thread.getValue(-1)).to.be.equal(state)

        thread.pop()
    })

    it('pushValue of a thread onto itself should not move anything', async () => {
        using state = await getState()
        const thread = state.newThread()

        thread.pushValue(thread)

        expect(thread.getTop()).to.be.equal(1)
        expect(thread.getValue(-1)).to.be.equal(thread)

        thread.pop()
    })

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
        state.set('thing', copy({}, { metatable: { __tostring: () => 'rendered' } }))
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

    it('should take a raw table index as a number', async () => {
        using state = await getState()
        state.module.lua_createtable(state.address, 3, 0)

        for (const [index, text] of ['a', 'b', 'c'].entries()) {
            state.pushValue(text)
            state.module.lua_rawseti(state.address, -2, index + 1)
        }
        state.module.lua_setglobal(state.address, 'letters')

        expect(await state.doString('return table.concat(letters, ",")')).to.be.equal('a,b,c')
        expect(state.module.lua_getglobal(state.address, 'letters')).to.be.equal(LuaType.Table)
        expect(state.module.lua_rawgeti(state.address, -1, 2)).to.be.equal(LuaType.String)
        expect(state.getValue(-1)).to.be.equal('b')
    })

    it('should refuse a number that is not a safe integer where a lua_Integer is expected', async () => {
        using state = await getState()

        expect(() => state.module.lua_pushinteger(state.address, 1.5)).to.throw(RangeError)
        expect(() => state.module.lua_pushinteger(state.address, 2 ** 53)).to.throw(RangeError)
        expect(() => state.module.lua_pushinteger(state.address, Number.NaN)).to.throw(RangeError)
        expect(state.getTop()).to.be.equal(0)
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
