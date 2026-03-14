declare namespace Emscripten{type JSType='number'|'string'|'array'|'boolean';type TypeCompatibleWithC=number|bigint|string|boolean|null|undefined|ArrayLike<number>;interface FileSystemType{}}
declare interface EmscriptenModule{_free(pointer:number):void}
declare function ccall(name:string,returnType:Emscripten.JSType|null,argTypes:Emscripten.JSType[],args:Emscripten.TypeCompatibleWithC[]):any
declare function addFunction(fn:(...args:number[])=>number|void,signature?:string):number
declare function removeFunction(funcPtr:number):void
declare function setValue(ptr:number,value:number,type:string):void
declare function getValue(ptr:number,type:string):number
declare function allocateUTF8(value:string):number
declare function lengthBytesUTF8(value:string):number
declare function stringToUTF8(value:string,outPtr:number,maxBytesToWrite:number):void
declare function intArrayFromString(value:string,dontAddNull?:boolean):number[]
declare function UTF8ToString(ptr:number):string
