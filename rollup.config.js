import typescript from '@rollup/plugin-typescript'
import url from '@rollup/plugin-url'

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
        url({
            include: '**/*.wasm',
            fileName: '[name][extname]',
        }),
        typescript({
            sourceMap: !production,
        }),
    ],
}
