import { copyFile } from 'node:fs/promises'
import { defineConfig } from 'rolldown'
import { replacePlugin } from 'rolldown/plugins'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
    input: './src/index.ts',
    output: {
        file: 'dist/index.js',
        format: 'esm',
        sourcemap: true,
    },
    external: ['node:module', 'node:fs', 'node:child_process'],
    plugins: [
        replacePlugin({
            // Webpack workaround: https://github.com/webpack/webpack/issues/16878
            'import.meta': 'Object(import.meta)',
        }),
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
            name: 'copy-glue-wasm',
            async writeBundle() {
                await copyFile('build/glue.wasm', 'dist/glue.wasm')
            },
        },
    ],
})
