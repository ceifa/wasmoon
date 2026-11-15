import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
const decoder = new TextDecoder()
const heap = new Uint8Array(1 << 16)
const SIZE = 256
function original(pointer, length) {
    const codes = new Array(length)
    let index = 0
    while (index < length) {
        const code = heap[pointer + index]
        if (code > 127) break
        codes[index++] = code
    }
    if (index === length) return String.fromCharCode.apply(null, codes)
    return decoder.decode(heap.subarray(pointer, pointer + length))
}
function same(text, pointer) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) !== heap[pointer + i]) return false
    return true
}
// A: current (verify on equal length, two passes)
const aStrings = new Array(SIZE).fill(''), aHits = new Uint8Array(SIZE)
function current(pointer, length) {
    let hash = length, index = 0
    while (index < length) { const code = heap[pointer + index]; if (code > 127) break; hash = (hash * 31 + code) | 0; index++ }
    if (index === length) {
        const slot = hash & (SIZE - 1), cached = aStrings[slot]
        if (cached.length === length && same(cached, pointer)) { aHits[slot] = 1; return cached }
        const codes = new Array(length)
        for (index = 0; index < length; index++) codes[index] = heap[pointer + index]
        const text = String.fromCharCode.apply(null, codes)
        if (aHits[slot]) aHits[slot] = 0; else aStrings[slot] = text
        return text
    }
    return decoder.decode(heap.subarray(pointer, pointer + length))
}
// B: two passes, verify only when the stored hash matches
const bStrings = new Array(SIZE).fill(''), bHashes = new Int32Array(SIZE), bHits = new Uint8Array(SIZE)
function hashGuarded(pointer, length) {
    let hash = length, index = 0
    while (index < length) { const code = heap[pointer + index]; if (code > 127) break; hash = (Math.imul(hash, 31) + code) | 0; index++ }
    if (index === length) {
        const slot = hash & (SIZE - 1)
        if (bHashes[slot] === hash) { const cached = bStrings[slot]; if (cached.length === length && same(cached, pointer)) { bHits[slot] = 1; return cached } }
        const codes = new Array(length)
        for (index = 0; index < length; index++) codes[index] = heap[pointer + index]
        const text = String.fromCharCode.apply(null, codes)
        if (bHits[slot]) bHits[slot] = 0; else { bStrings[slot] = text; bHashes[slot] = hash }
        return text
    }
    return decoder.decode(heap.subarray(pointer, pointer + length))
}
// C: one pass gathering and hashing, verify only when the stored hash matches
const cStrings = new Array(SIZE).fill(''), cHashes = new Int32Array(SIZE), cHits = new Uint8Array(SIZE)
function singlePass(pointer, length) {
    const codes = new Array(length)
    let hash = length, index = 0
    while (index < length) { const code = heap[pointer + index]; if (code > 127) break; hash = (Math.imul(hash, 31) + code) | 0; codes[index++] = code }
    if (index === length) {
        const slot = hash & (SIZE - 1)
        if (cHashes[slot] === hash) { const cached = cStrings[slot]; if (cached.length === length && same(cached, pointer)) { cHits[slot] = 1; return cached } }
        const text = String.fromCharCode.apply(null, codes)
        if (cHits[slot]) cHits[slot] = 0; else { cStrings[slot] = text; cHashes[slot] = hash }
        return text
    }
    return decoder.decode(heap.subarray(pointer, pointer + length))
}
// D: B without the second-chance bit
const dStrings = new Array(SIZE).fill(''), dHashes = new Int32Array(SIZE)
function plain(pointer, length) {
    let hash = length, index = 0
    while (index < length) { const code = heap[pointer + index]; if (code > 127) break; hash = (Math.imul(hash, 31) + code) | 0; index++ }
    if (index === length) {
        const slot = hash & (SIZE - 1)
        if (dHashes[slot] === hash) { const cached = dStrings[slot]; if (cached.length === length && same(cached, pointer)) return cached }
        const codes = new Array(length)
        for (index = 0; index < length; index++) codes[index] = heap[pointer + index]
        const text = String.fromCharCode.apply(null, codes)
        dStrings[slot] = text; dHashes[slot] = hash
        return text
    }
    return decoder.decode(heap.subarray(pointer, pointer + length))
}
// E: hash pass only, never stores (isolates the hashing cost)
const eHashes = new Int32Array(SIZE)
function hashOnly(pointer, length) {
    let hash = length, index = 0
    while (index < length) { const code = heap[pointer + index]; if (code > 127) break; hash = (Math.imul(hash, 31) + code) | 0; index++ }
    if (index === length) {
        const slot = hash & (SIZE - 1)
        if (eHashes[slot] === hash) return 'x'
        const codes = new Array(length)
        for (index = 0; index < length; index++) codes[index] = heap[pointer + index]
        return String.fromCharCode.apply(null, codes)
    }
    return decoder.decode(heap.subarray(pointer, pointer + length))
}
// F: store only on the second sighting of the same hash
const fStrings = new Array(SIZE).fill(''), fHashes = new Int32Array(SIZE), fSeen = new Int32Array(SIZE)
function secondTouch(pointer, length) {
    let hash = length, index = 0
    while (index < length) { const code = heap[pointer + index]; if (code > 127) break; hash = (Math.imul(hash, 31) + code) | 0; index++ }
    if (index === length) {
        const slot = hash & (SIZE - 1)
        if (fHashes[slot] === hash) { const cached = fStrings[slot]; if (cached.length === length && same(cached, pointer)) return cached }
        const codes = new Array(length)
        for (index = 0; index < length; index++) codes[index] = heap[pointer + index]
        const text = String.fromCharCode.apply(null, codes)
        if (fSeen[slot] === hash) { fStrings[slot] = text; fHashes[slot] = hash } else fSeen[slot] = hash
        return text
    }
    return decoder.decode(heap.subarray(pointer, pointer + length))
}
const variants = [original, plain, hashOnly, secondTouch]
const enc = new TextEncoder()
// Workloads: list of strings laid out in the heap, read cyclically.
function layout(strings) { let p = 8; const spans = []; for (const s of strings) { const b = enc.encode(s); heap.set(b, p); spans.push([p, b.length]); p += b.length + 1 } return spans }
const workloads = {
    'hot keys (id,name,active)': layout(['id', 'name', 'active']),
    'hot keys (nested,value)': layout(['nested', 'value']),
    'distinct keys item1..2000': layout(Array.from({ length: 2000 }, (_, i) => `item${i + 1}`)),
    'mixed: 3 keys + 1 distinct value per entry': (() => { const out = []; const keys = layout(['id', 'name', 'active']); const vals = layout(Array.from({ length: 2000 }, (_, i) => `item${i + 1}`)); for (let i = 0; i < 2000; i++) { out.push(keys[0], keys[1], vals[i], keys[2]) } return out })(),
    '24-char repeated': layout(['abcdefghijabcdefghijabcd']),
}
for (const [name, spans] of Object.entries(workloads)) {
    for (const v of variants) if (v !== hashOnly) for (const [p, l] of spans) assert.equal(v(p, l), original(p, l))
    const samples = variants.map(() => [])
    const n = 200000
    for (let round = 0; round < 24; round++) {
        const order = round % 2 ? [3, 2, 1, 0] : [0, 1, 2, 3]
        for (const v of order) {
            const f = variants[v]
            let sink = 0
            const start = performance.now()
            for (let i = 0; i < n; i++) { const [p, l] = spans[i % spans.length]; sink += f(p, l).length }
            if (round >= 4) samples[v].push(performance.now() - start)
            if (sink < 0) throw new Error()
        }
    }
    const med = samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1])
    console.log(name.padEnd(46), variants.map((v, i) => `${v.name}=${med[i].toFixed(2)}`).join('  '))
}
