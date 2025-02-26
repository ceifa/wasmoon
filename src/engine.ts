import { CreateEngineOptions } from './types'
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
        this.global.loadString(script)
        const result = this.global.runSync()
        return result[0]
    }

    /**
     * Executes Lua code from a file synchronously.
     * @param filename - Path to the Lua script file.
     * @returns - The result returned by the Lua script.
     */
    public doFileSync(filename: string): any {
        this.global.loadFile(filename)
        const result = this.global.runSync()
        return result[0]
    }

    // WARNING: It will not wait for open handles and can potentially cause bugs if JS code tries to reference Lua after executed
    private async callByteCode(loader: (thread: Thread) => void): Promise<any> {
        const thread = this.global.newThread()
        const threadIndex = this.global.getTop()
        try {
            loader(thread)
            const result = await thread.run(0)
            if (result.length > 0) {
                // The shenanigans here are to return the first result value on the stack.
                // Say there's 2 values at stack indexes 1 and 2. Then top is 2, result.length is 2.
                // That's why there's a + 1 sitting at the end.
                return thread.getValue(thread.getTop() - result.length + 1)
            }
            return undefined
        } finally {
            // Pop the read on success or failure
            this.global.remove(threadIndex)
        }
    }
}
