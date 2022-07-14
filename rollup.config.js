import typescript from '@rollup/plugin-typescript'
import copy from 'rollup-plugin-copy'
import { version } from './package.json'

const production = !process.env.ROLLUP_WATCH

export default {
    input: './src/index.ts',
    output: {
        file: 'dist/index.js',
        format: 'umd',
        name: 'wasmoon',
        sourcemap: !production,
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
                    return `export default '${version}'`
                }
            },
        },
        typescript({
            sourceMap: !production,
            outputToFilesystem: true,
        }),
        copy({
            targets: [{ src: 'build/glue.wasm', dest: 'dist' }],
        }),
    ],
}
