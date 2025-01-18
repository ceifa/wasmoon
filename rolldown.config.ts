import copy from 'rollup-plugin-copy'
import pkg from './package.json' with { type: 'json' }

const production = !process.env.ROLLUP_WATCH

export default {
    input: './src/index.ts',
    output: {
        file: 'dist/index.js',
        format: 'esm',
        sourcemap: !production,
    },
    define: {
        // Webpack workaround: https://github.com/webpack/webpack/issues/16878
        'import.meta': 'Object(import.meta)',
    },
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
        copy({
            targets: [{ src: 'build/glue.wasm', dest: 'dist' }],
        }),
    ],
}
