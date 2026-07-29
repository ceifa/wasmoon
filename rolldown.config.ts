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
            // The glue is generated and already minified onto one line, so carrying its 85 KB of
            // source in the published sourcemap costs a tenth of the package to map frames nobody
            // reads. The mappings stay, only the inlined copy of the file goes.
            name: 'drop-glue-source-content',
            generateBundle(_options, bundle) {
                // Rewritten through the emitted asset rather than the written file, because
                // `chunk.map` is a snapshot of the Rust side and mutating it does not carry over.
                let dropped = false
                for (const file of Object.values(bundle)) {
                    if (file.type !== 'asset' || !file.fileName.endsWith('.map')) {
                        continue
                    }
                    const map = JSON.parse(file.source as string)
                    const index = map.sources.findIndex((source: string) => source?.endsWith('glue.js'))
                    if (index < 0 || !map.sourcesContent?.[index]) {
                        continue
                    }
                    map.sourcesContent[index] = null
                    file.source = JSON.stringify(map)
                    dropped = true
                }
                if (!dropped) {
                    // A silent miss would quietly put the 85 KB back into every published package.
                    this.error('the glue source was not found in any sourcemap, so nothing was dropped')
                }
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
