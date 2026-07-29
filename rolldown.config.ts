import { copyFile } from 'node:fs/promises'
import { defineConfig } from 'rolldown'
import pkg from './package.json' with { type: 'json' }
import { UNWIND_BRAND } from './src/utils'

export default defineConfig({
    input: './src/index.ts',
    output: {
        // A directory rather than a single file, because the host filesystem glue that module.ts
        // imports on demand has to stay a chunk of its own: a browser bundle then leaves it alone,
        // and Node loads it only when someone asks for `fs: 'host'`.
        dir: 'dist',
        entryFileNames: 'index.js',
        // Named rather than hashed, so the `browser` field in package.json can point at it.
        chunkFileNames: 'glue-host.js',
        format: 'esm',
        sourcemap: true,
        // The glue arrives from emcc already minified and rolldown would otherwise re-print it
        // several kilobytes larger than it started. Consumers minify us anyway -- which the
        // Bundling suite covers -- so doing it here only decides what the package and a CDN
        // consumer download. The sourcemap keeps our own frames readable.
        minify: { mangle: { toplevel: false } },
    },
    // Only the glue imports a node builtin now; the mounts reach node:fs through
    // process.getBuiltinModule, which a bundler never has to resolve.
    external: ['node:module'],
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
            // A node builtin is imported behind a runtime check for Node, which a bundler targeting
            // the browser does not see, so it refuses to resolve it. webpack takes the comment; the
            // others go by the `browser` field in package.json.
            //
            // In generateBundle rather than renderChunk because minification runs in between and
            // strips comments: annotating earlier would leave the guard below passing while the
            // published chunk had no annotation left in it. Column mappings on the one line this
            // touches shift by the length of the comment, which only ever falls inside the glue --
            // whose source the next plugin drops from the sourcemap anyway.
            name: 'annotate-node-imports',
            generateBundle(_options, bundle) {
                for (const chunk of Object.values(bundle)) {
                    if (chunk.type !== 'chunk') {
                        continue
                    }
                    // Quotes of either kind, since a minifier picks its own, and the whitespace is
                    // not optional to match: an import the output happens to wrap over several lines
                    // is the same import, and skipping it would ship it unannotated.
                    chunk.code = chunk.code.replace(/import\(\s*(['"`])(node:[^'"`]+)\1\s*\)/g, 'import(/* webpackIgnore: true */ $1$2$1)')
                    const missed = /import\(\s*(?!\/\*)(['"`])node:/.exec(chunk.code)
                    if (missed) {
                        this.error(`${chunk.fileName} ships a node builtin import with no annotation: ${missed[0]}`)
                    }
                }
            },
        },
        {
            // The glue is generated and already minified onto one line, so its source is not worth
            // publishing: carrying it costs a tenth of the package to map frames nobody reads. What
            // is left of each sourcemap depends on whether anything else is in the chunk.
            name: 'trim-glue-sourcemaps',
            generateBundle(_options, bundle) {
                // Rewritten through the emitted files rather than the written ones, because
                // `chunk.map` is a snapshot of the Rust side and mutating it does not carry over.
                // Counted per sourcemap: there is one for each glue now, and a single flag would
                // call it a success while the other still shipped its copy.
                let trimmed = 0
                for (const chunk of Object.values(bundle)) {
                    const map = bundle[`${chunk.fileName}.map`]
                    if (chunk.type !== 'chunk' || map?.type !== 'asset') {
                        continue
                    }
                    const parsed = JSON.parse(map.source as string)
                    const index = parsed.sources.findIndex((source: string) => source?.endsWith('glue.js'))
                    if (index < 0) {
                        continue
                    }

                    if (parsed.sources.length === 1) {
                        // Nothing but the glue in this chunk, so the mappings lead only to a file
                        // that is not published and whose content is dropped below anyway. The whole
                        // sourcemap goes, and with it the comment pointing at it.
                        delete bundle[`${chunk.fileName}.map`]
                        chunk.code = chunk.code.replace(/\n?\/\/# sourceMappingURL=.*$/, '\n')
                        trimmed++
                        continue
                    }

                    if (!parsed.sourcesContent?.[index]) {
                        // A silent miss would quietly put the 85 KB back into every published package.
                        this.error(`${map.fileName} maps a glue but carries no source to drop`)
                    }
                    // Our own sources are in here too, so only the glue's copy of itself goes.
                    parsed.sourcesContent[index] = null
                    map.source = JSON.stringify(parsed)
                    trimmed++
                }
                // One for the entry's inlined glue, one for the host glue chunk.
                if (trimmed !== 2) {
                    this.error(`expected to trim the glue out of 2 sourcemaps, trimmed ${trimmed}`)
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
