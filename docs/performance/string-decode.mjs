import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
const decoder = new TextDecoder()
const heap = new Uint8Array(1024)
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
function view(pointer, length) {
    let index = 0
    while (index < length && heap[pointer + index] <= 127) index++
    const bytes = heap.subarray(pointer, pointer + length)
    return index === length ? String.fromCharCode.apply(null, bytes) : decoder.decode(bytes)
}
function scanFirst(pointer, length) {
    let index = 0
    while (index < length && heap[pointer + index] <= 127) index++
    if (index !== length) return decoder.decode(heap.subarray(pointer, pointer + length))
    const codes = new Array(length)
    for (index = 0; index < length; index++) codes[index] = heap[pointer + index]
    return String.fromCharCode.apply(null, codes)
}
// Isolates the short-string decoder; it does not measure Lua/Wasm crossings.
const cutoff = process.argv.includes('--cutoff')
const variants = cutoff
    ? [original, view, (pointer, length) => decoder.decode(heap.subarray(pointer, pointer + length))]
    : [original, view, scanFirst]
const values = cutoff
    ? [32, 40, 48, 64, 80, 96, 128].map((n) => 'a'.repeat(n))
    : ['a', 'hello', 'abcdefghijklmno', 'a'.repeat(32), 'ação', 'こんにちは', 'a'.repeat(25) + 'é']
for (const bytes of [new Uint8Array([0, 65, 0]), new Uint8Array([255, 128, 65]), new TextEncoder().encode('é😀')]) {
    heap.set(bytes, 8)
    for (const variant of variants) assert.equal(variant(8, bytes.length), decoder.decode(bytes))
}
let sink = 0
for (const value of values) {
    const bytes = new TextEncoder().encode(value)
    heap.set(bytes, 8)
    for (const variant of variants) assert.equal(variant(8, bytes.length), value)
    const samples = [[], [], []]
    for (let round = 0; round < 25; round++)
        for (const v of round % 2 ? [2, 1, 0] : [0, 1, 2]) {
            const f = variants[v]
            const start = performance.now()
            for (let i = 0; i < 200000; i++) sink += f(8, bytes.length).length
            if (round >= 5) samples[v].push(performance.now() - start)
        }
    console.log(JSON.stringify({ value, ms: samples.map((s) => s.sort((a, b) => a - b)[10]) }))
}
console.log(sink)
