import typescript from '@rollup/plugin-typescript'
import copy from 'rollup-plugin-copy'

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
        typescript({
            sourceMap: !production,
        }),
        copy({
            targets: [{ src: 'build/glue.wasm', dest: 'dist' }]
        })
    ],
}
