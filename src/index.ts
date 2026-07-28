export { default as LuaRuntime } from './runtime'
export { default as LuaState, type LuaMemory } from './state'
export { default as LuaThread } from './thread'
export { default as LuaMultiReturn } from './multireturn'
export { default as LuaRawResult } from './raw-result'
export { decorate, Decoration, type DecorationOptions, type DecorationTarget } from './decoration'
// Export the underlying bindings to allow users to just
// use the bindings rather than the wrappers.
export { default as LuaModule } from './module'
export { default as LuaTypeExtension } from './type-extension'
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
} from './types'

import LuaRuntime from './runtime'
export default LuaRuntime
