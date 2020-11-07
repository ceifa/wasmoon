const path = require("path");

module.exports = {
    entry: "./src/index.ts",
    output: {
        path: path.resolve(__dirname, "dist"),
        filename: "index.js",
        libraryTarget: 'umd',
        globalObject: "(typeof self !== 'undefined' ? self : this)"
    },
    resolve: {
        extensions: ['.ts', '.js', '.wasm'],
        fallback: {
            crypto: false,
            fs: false,
            child_process: false,
            path: false
        }
    },
    module: {
        defaultRules: [
            {
                type: "javascript/auto",
                resolve: {}
            }
        ],
        rules: [
            {
                test: /glue\.wasm$/,
                type: "javascript/auto",
                loader: "file-loader",
                options: {
                    publicPath: "dist/"
                }
            },
            {
                test: /\.ts$/,
                loader: 'awesome-typescript-loader'
            }
        ]
    }
};