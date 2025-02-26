export { default as LuaEngine } from './engine'
export { default as Lua } from './lua'
export { default as LuaGlobal } from './global'
export { default as LuaMultiReturn } from './multireturn'
export { default as LuaRawResult } from './raw-result'
export { default as LuaThread } from './thread'
// Export the underlying bindings to allow users to just
// use the bindings rather than the wrappers.
export { decorate, Decoration } from './decoration'
export { default as LuaModule } from './module'
export { default as LuaTypeExtension } from './type-extension'
export { decorateFunction } from './type-extensions/function'
export { decorateProxy } from './type-extensions/proxy'
export { decorateUserdata } from './type-extensions/userdata'
export * from './types'

import Lua from './lua'
export default Lua
