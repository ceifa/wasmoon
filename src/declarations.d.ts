declare module '*.wasm' {
    const value: string
    export default value
}

// The emscripten glue is generated JS, so it has no types of its own. Declaring the factory rather
// than the whole module keeps the init options checked against what the build actually accepts
// (see INCOMING_MODULE_JS_API in utils/build-wasm.sh).
declare module '*/glue.js' {
    const initWasmModule: (
        moduleArg?: Partial<Pick<EmscriptenModule, 'locateFile' | 'print' | 'printErr'>> & {
            preRun?: (module: import('./module').LuaEmscriptenModule) => void
        },
    ) => Promise<import('./module').LuaEmscriptenModule>
    export default initWasmModule
}

declare module 'package-version' {
    const value: string
    export default value
}
