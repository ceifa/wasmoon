declare module '*.wasm' {
    const value: string
    export default value
}

// The emscripten glue is generated JS, so it has no types of its own. Declaring the factory rather
// than the whole module keeps the init options checked against what the build actually accepts
// (see INCOMING_MODULE_JS_API in utils/build-wasm.sh).
declare module '*/glue.js' {
    const initWasmModule: (
        moduleArg?: Partial<Pick<EmscriptenModule, 'print' | 'printErr'>> & {
            instantiateWasm: (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) => void
            preRun?: (module: import('./module').LuaEmscriptenModule) => void
            // Read by the glue without a filesystem only; see utils/no-filesystem.js.
            stdin?: (() => number | null) | null
            stdout?: ((charCode: number | null) => void) | null
            stderr?: ((charCode: number | null) => void) | null
        },
    ) => Promise<import('./module').LuaEmscriptenModule>
    export default initWasmModule
}

declare module 'package-version' {
    const value: string
    export default value
}

declare module 'wasm-integrity' {
    const value: string
    export default value
}

declare namespace WebAssembly {
    function promising<T extends (...args: any[]) => any>(fn: T): (...args: Parameters<T>) => Promise<ReturnType<T>>
    const Suspending: new (fn: (...args: any[]) => any) => (...args: any[]) => any
}
