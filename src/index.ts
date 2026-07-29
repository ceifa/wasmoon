export { default as LuaRuntime } from './runtime'
export { default as LuaState, type LuaMemory } from './state'
export { default as LuaThread, type OrderedExtension } from './thread'
export { default as LuaMultiReturn } from './multireturn'
export { default as LuaRawResult } from './raw-result'
export { decorate, Decoration, type DecorationOptions, type DecorationTarget, type LuaMetatable } from './decoration'
// Export the underlying bindings to allow users to just
// use the bindings rather than the wrappers.
export {
    default as LuaModule,
    type EmscriptenFS,
    type EmscriptenPath,
    type EnvironmentVariables,
    type LuaEmscriptenModule,
    type LuaModuleOptions,
} from './module'
export { default as LuaTypeExtension } from './type-extension'
// The built in extensions are not exported, but the value types they marshal are, so a custom
// extension can describe what it handles.
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
    type LuaLibName,
    type LuaLoadMode,
    type LuaWarnHandler,
    type CreateStateOptions,
    type LuaMemoryOptions,
    type LuaLimitOptions,
    type LuaRunOptions,
    type LuaLoadOptions,
    type LuaDoOptions,
    type LuaThreadLimits,
    type LuaResumeResult,
    type LuaGetCache,
    type LuaPushCache,
} from './types'

import LuaRuntime from './runtime'
export default LuaRuntime
