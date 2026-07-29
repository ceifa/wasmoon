import { copyFile } from 'node:fs/promises'
import { defineConfig } from 'rolldown'
import pkg from './package.json' with { type: 'json' }
import { UNWIND_BRAND } from './src/utils'

export default defineConfig({
    input: './src/index.ts',
    output: {
        file: 'dist/index.js',
        format: 'esm',
        sourcemap: true,
    },
    external: ['node:module', 'node:fs'],
    plugins: [
        {
            name: 'package-version',
            resolveId(source) {
                if (source === 'package-version') {
                    return 'package-version'
                }
            },
            load(id) {
                if (id === 'package-version') {
                    return `export default '${pkg.version}'`
                }
            },
        },
        {
            // A consumer's minifier renames the glue's unwind class but not a string compared
            // against its name, so isEmscriptenUnwind goes by a brand on the prototype instead.
            name: 'emscripten-unwind-brand',
            transform(code, id) {
                if (!id.endsWith('glue.js')) {
                    return
                }
                const branded = code.replace(/class EmscriptenEH\s*\{\s*\}/, (match) => {
                    return `${match}EmscriptenEH.prototype.${UNWIND_BRAND}=true;`
                })
                if (branded === code) {
                    // A silent miss would ship a build where every Lua error path is subtly wrong.
                    this.error('EmscriptenEH declaration not found in the glue, so the unwind brand would be a no-op')
                }
                // Generated code with no sourcemap of its own, so there is nothing to preserve.
                return { code: branded, map: null }
            },
        },
        {
            // Both node builtins are imported behind a runtime check for Node, which a bundler
            // targeting the browser does not see, so it refuses to resolve them. webpack takes the
            // comment; the others go by the `browser` field in package.json.
            name: 'annotate-node-imports',
            renderChunk(code) {
                const annotated = code.replace(/import\((['"])(node:[^'"]+)\1\)/g, 'import(/* webpackIgnore: true */ $1$2$1)')
                const missed = /import\((?!\s*\/\*)(['"])node:/.exec(annotated)
                if (missed) {
                    this.error(`a node builtin import was left unannotated: ${missed[0]}`)
                }
                return { code: annotated, map: null }
            },
        },
        {
            name: 'copy-glue-wasm',
            async writeBundle() {
                await copyFile('build/glue.wasm', 'dist/glue.wasm')
            },
        },
    ],
})
