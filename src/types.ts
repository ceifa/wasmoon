export type LuaState = number

export const enum LuaReturn {
    Ok = 0,
    Yield = 1,
    ErrorRun = 2,
    ErrorSyntax = 3,
    ErrorMem = 4,
    ErrorErr = 5,
    ErrorFile = 6
}

export const LUA_MULTRET = -1
export const LUAI_MAXSTACK = 1000000
export const LUA_REGISTRYINDEX = -LUAI_MAXSTACK - 1000

export const enum LuaType {
    None = -1,
    Nil = 0,
    Boolean = 1,
    LightUserData = 2,
    Number = 3,
    String = 4,
    Table = 5,
    Function = 6,
    UserData = 7,
    Thread = 8
}

declare global {
	var FinalizationRegistry: any
}