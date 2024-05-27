export type LuaState = number

export type EnvironmentVariables = Record<string, string | undefined>

export interface CreateEngineOptions {
    /** Injects all the lua standard libraries (math, coroutine, debug) */
    openStandardLibs?: boolean
    /** Injects some JS objects to the Lua environment: Error, Promise, null, Objects */
    injectObjects?: boolean
    /** Enables the proxy for JS objects, useful for classes, etc... */
    enableProxy?: boolean
    /** Whether to trace memory allocations. */
    traceAllocations?: boolean
    /** Maximum time in milliseconds a Lua function can run before being interrupted. */
    functionTimeout?: number
}

export enum LuaReturn {
    Ok = 0,
    Yield = 1,
    ErrorRun = 2,
    ErrorSyntax = 3,
    ErrorMem = 4,
    ErrorErr = 5,
    ErrorFile = 6,
}

export interface LuaResumeResult {
    result: LuaReturn
    resultCount: number
}

export interface LuaThreadRunOptions {
    timeout?: number
}

export const PointerSize = 4

export const LUA_MULTRET = -1
export const LUAI_MAXSTACK = 1000000
export const LUA_REGISTRYINDEX = -LUAI_MAXSTACK - 1000

export enum LuaType {
    None = -1,
    Nil = 0,
    Boolean = 1,
    LightUserdata = 2,
    Number = 3,
    String = 4,
    Table = 5,
    Function = 6,
    Userdata = 7,
    Thread = 8,
}

export enum LuaEventCodes {
    Call = 0,
    Ret = 1,
    Line = 2,
    Count = 3,
    TailCall = 4,
}

export enum LuaEventMasks {
    Call = 1 << LuaEventCodes.Call,
    Ret = 1 << LuaEventCodes.Ret,
    Line = 1 << LuaEventCodes.Line,
    Count = 1 << LuaEventCodes.Count,
}

export enum LuaLibraries {
    Base = '_G',
    Coroutine = 'coroutine',
    Table = 'table',
    IO = 'io',
    OS = 'os',
    String = 'string',
    UTF8 = 'utf8',
    Math = 'math',
    Debug = 'debug',
    Package = 'package',
}

export class LuaTimeoutError extends Error {}
