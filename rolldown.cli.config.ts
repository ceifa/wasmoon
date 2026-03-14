import { defineConfig } from 'rolldown'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
    input: './src/cli.js',
    output: {
        file: 'dist/cli.js',
        format: 'esm',
        sourcemap: false,
    },
    platform: 'node',
    external: ['./index.js', 'node:fs', 'node:readline'],
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
    ],
})
