export { default as LuaRuntime } from './runtime'
export { default as LuaState, type LuaMemory } from './state'
export type { default as LuaGarbageCollector } from './gc'
export { default as LuaThread } from './thread'
export { default as LuaMultiReturn } from './multireturn'
export { copy, proxy, opaque, raw, LuaMarshalled, type LuaCopyOptions, type LuaMarshalMode, type LuaRawFunction } from './marshal'
// Export the underlying bindings to allow users to just
// use the bindings rather than the wrappers.
export {
    default as LuaModule,
    type EmscriptenFS,
    type EmscriptenPath,
    type EnvironmentVariables,
    type LuaEmscriptenModule,
    type LuaFileSystem,
    type LuaModuleOptions,
} from './module'
export type { FunctionType } from './type-extensions/function'
export type { TableType } from './type-extensions/table'
// Named rather than `export *`, so the library bitmask helpers and the warn default stay internal.
export {
    LuaError,
    LuaInterruptError,
    LuaTimeoutError,
    LuaInstructionLimitError,
    LuaAbortError,
    LuaReturn,
    LuaType,
    LuaEventCodes,
    LuaEventMasks,
    LUA_MULTRET,
    LUA_REGISTRYINDEX,
    LUAI_MAXSTACK,
    LUA_LIB_BITS,
    PointerSize,
    type LuaAddress,
    type LuaInjectName,
    type LuaLibName,
    type LuaLoadMode,
    type LuaWarnHandler,
    type CreateStateOptions,
    type LuaMemoryOptions,
    type LuaLimits,
    type LuaClass,
    type LuaClassOptions,
    type LuaTypeDefinition,
    type LuaGcOptions,
    type LuaGcMode,
    type LuaGcParam,
    type LuaRunOptions,
    type LuaLoadOptions,
    type LuaDoOptions,
    type LuaResumeResult,
    type LuaGetCache,
    type LuaPushCache,
} from './types'

import LuaRuntime from './runtime'
export default LuaRuntime
