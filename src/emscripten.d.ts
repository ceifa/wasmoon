declare namespace Emscripten{type JSType='number'|'string'|'array'|'boolean';type TypeCompatibleWithC=number|bigint|string|boolean|null|undefined|ArrayLike<number>;interface FileSystemType{}}
declare interface EmscriptenModule{_free(n:number):void}
declare function ccall(n:string,r:Emscripten.JSType|null,t:Emscripten.JSType[],a:Emscripten.TypeCompatibleWithC[]):any
declare function addFunction(f:(...a:number[])=>number|void,s?:string):number
declare function removeFunction(n:number):void
declare function setValue(p:number,v:number,t:string):void
declare function getValue(p:number,t:string):number
declare function allocateUTF8(s:string):number
declare function lengthBytesUTF8(s:string):number
declare function stringToUTF8(s:string,p:number,m:number):void
declare function intArrayFromString(s:string,n?:boolean):number[]
declare function UTF8ToString(p:number):string
