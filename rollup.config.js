import typescript from '@rollup/plugin-typescript';
import url from '@rollup/plugin-url';

export default {
    input: './src/index.ts',
    output: {
        file: 'dist/index.js',
        format: 'umd',
        name: 'wasmoon',
        sourcemap: true
    },
    plugins: [
        url({
            include: '**/*.wasm',
            fileName: '[name][extname]'
        }),
        typescript({
            inlineSources: true,
            removeComments: true,
            sourceMap: true
        })
    ]
}