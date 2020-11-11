export type LuaState = number;

export const enum LuaReturn {
    Ok = 0,
    ErrorRun = 1,
    ErrorMem = 2,
    ErrorErr = 3,
    ErrorSyntax = 4,
    Yield = 5
}

export const LUAI_MAXSTACK = 1000000;
export const LUA_REGISTRYINDEX = -LUAI_MAXSTACK - 1000;

export type AnyObject = { [key: string]: any };

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