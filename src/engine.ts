import { CreateEngineOptions, LUA_REGISTRYINDEX } from './types'
import Global from './global'
import type LuaModule from './module'
import Thread from './thread'
import createErrorType from './type-extensions/error'
import createFunctionType from './type-extensions/function'
import createNullType from './type-extensions/null'
import createPromiseType from './type-extensions/promise'
import createProxyType from './type-extensions/proxy'
import createTableType from './type-extensions/table'
import createUserdataType from './type-extensions/userdata'

export default class LuaEngine {
    public global: Global

    public constructor(
        private module: LuaModule,
        {
            openStandardLibs = true,
            injectObjects = false,
            enableProxy = true,
            traceAllocations = false,
            functionTimeout = undefined as number | undefined,
        }: CreateEngineOptions = {},
    ) {
        this.global = new Global(this.module, traceAllocations)

        // Generic handlers - These may be required to be registered for additional types.
        this.global.registerTypeExtension(0, createTableType(this.global))
        this.global.registerTypeExtension(0, createFunctionType(this.global, { functionTimeout }))

        // Contains the :await functionality.
        this.global.registerTypeExtension(1, createPromiseType(this.global, injectObjects))

        if (injectObjects) {
            // Should be higher priority than table since that catches generic objects along
            // with userdata so it doesn't end up a userdata type.
            this.global.registerTypeExtension(5, createNullType(this.global))
        }

        if (enableProxy) {
            // This extension only really overrides tables and arrays.
            // When a function is looked up in one of it's tables it's bound and then
            // handled by the function type extension.
            this.global.registerTypeExtension(3, createProxyType(this.global))
        } else {
            // No need to register this when the proxy is enabled.
            this.global.registerTypeExtension(1, createErrorType(this.global, injectObjects))
        }

        // Higher priority than proxied objects to allow custom user data without exposing methods.
        this.global.registerTypeExtension(4, createUserdataType(this.global))

        if (openStandardLibs) {
            this.module.luaL_openlibs(this.global.address)
        }
    }

    /**
     * Executes Lua code from a string asynchronously.
     * @param script - Lua script to execute.
     * @returns A Promise that resolves to the result returned by the Lua script execution.
     */
    public doString(script: string): Promise<any> {
        return this.callByteCode((thread) => thread.loadString(script))
    }

    /**
     * Executes Lua code from a file asynchronously.
     * @param filename - Path to the Lua script file.
     * @returns - A Promise that resolves to the result returned by the Lua script execution.
     */
    public doFile(filename: string): Promise<any> {
        return this.callByteCode((thread) => thread.loadFile(filename))
    }

    /**
     * Executes Lua code from a string synchronously.
     * @param script - Lua script to execute.
     * @returns - The result returned by the Lua script.
     */
    public doStringSync(script: string): any {
        return this.callByteCodeSync((thread) => thread.loadString(script))
    }

    /**
     * Executes Lua code from a file synchronously.
     * @param filename - Path to the Lua script file.
     * @returns - The result returned by the Lua script.
     */
    public doFileSync(filename: string): any {
        return this.callByteCodeSync((thread) => thread.loadFile(filename))
    }

    private callByteCodeSync(loader: (thread: Thread) => void): any {
        // Runs on the global thread, so leftovers would accumulate for the lifetime of the state.
        // runSync has already converted the results to JS, and anything that has to outlive them
        // holds its own registry reference.
        const startStackTop = this.global.getTop()
        try {
            loader(this.global)
            return this.global.runSync()[0]
        } finally {
            this.global.setTop(startStackTop)
        }
    }

    // WARNING: It will not wait for open handles and can potentially cause bugs if JS code tries to reference Lua after executed
    private async callByteCode(loader: (thread: Thread) => void): Promise<any> {
        const thread = this.global.newThread()
        // Move the thread off the global stack and into the registry as a GC anchor so it doesn't pile threads up into the stack
        const ref = this.module.luaL_ref(this.global.address, LUA_REGISTRYINDEX)
        try {
            loader(thread)
            return (await thread.run(0))[0]
        } finally {
            this.module.luaL_unref(this.global.address, LUA_REGISTRYINDEX, ref)
        }
    }
}
