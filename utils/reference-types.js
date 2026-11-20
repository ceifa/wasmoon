// The public declarations use `@types/emscripten`'s ambient globals (EmscriptenModule, FS,
// Emscripten.*). Those only resolve for a consumer whose own tsconfig happens to list
// "emscripten" in `types`, which nothing about depending on wasmoon makes them do -- so without
// this the published .d.ts fails to compile under, say, `"types": ["node"]`.
//
// A `/// <reference types="..." />` in the entry declaration pulls the package in for everyone.
// It has to be added here rather than written in the source, because tsc drops the directive on
// its way through declaration emit.
import { readFile, writeFile } from 'node:fs/promises'

const ENTRY = 'dist/index.d.ts'
const DIRECTIVE = '/// <reference types="emscripten" />'

const contents = await readFile(ENTRY, 'utf8')
if (!contents.startsWith(DIRECTIVE)) {
    await writeFile(ENTRY, `${DIRECTIVE}\n${contents}`)
}
