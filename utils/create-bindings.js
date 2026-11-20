// Turns the Lua headers into the two lists that have to agree with them: the bindings class
// LuaModule extends, and the functions emcc keeps in the wasm. Run by `npm run build:wasm`, and on
// its own (`node utils/create-bindings.js`) after moving the lua submodule.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const rootdir = resolve(import.meta.dirname, '..')
const HEADERS = ['lauxlib.h', 'lua.h', 'lualib.h']
const BINDINGS_FILE = 'src/bindings.gen.ts'
const EXPORTS_FILE = 'build/exported-functions.json'

// In the headers but not in the wasm. A variadic function is left out without being listed here.
const SKIPPED = [
    // Takes an array of strings.
    'luaL_checkoption',
    // New in Lua 5.5 and not exposed so far. Removing a name from here is all it takes.
    'luaL_alloc',
    'luaL_makeseed',
    'lua_numbertocstring',
    'lua_pushexternalstring',
]

// In the wasm, but bound by hand in src/module.ts: Lua strings carry a length, and lua_gc is variadic.
const HANDWRITTEN = ['lua_gc', 'lua_tolstring', 'luaL_tolstring', 'lua_pushstring']

const RETURNS_TYPE = [
    'luaL_getmetafield',
    'lua_type',
    'lua_getglobal',
    'lua_gettable',
    'lua_getfield',
    'lua_geti',
    'lua_rawget',
    'lua_rawgeti',
    'lua_rawgetp',
    'lua_getiuservalue',
]

const RETURNS_STATUS = [
    'luaL_loadfilex',
    'luaL_loadbufferx',
    'luaL_loadstring',
    'lua_closethread',
    'lua_pcallk',
    'lua_load',
    'lua_resume',
    'lua_status',
]

// Where the type a declaration maps to is not the one the binding takes.
const OVERRIDES = {
    // The buffer and the chunk name can also be pointers, and neither is a name worth caching.
    luaL_loadbufferx: { params: { buff: 'string | number | null', name: 'string | number | null' }, signature: 'nnSnSs' },
    // Takes a pointer and a length, so nothing is marshalled and the returned copy is not read.
    lua_pushlstring: { params: { s: 'number' }, returns: 'void', raw: true },
    lua_closethread: { params: { from: 'LuaAddress | null' } },
    lua_resume: { params: { from: 'LuaAddress | null' } },
}

const NUMBERS = ['int', 'unsigned', 'size_t', 'lua_Number', 'lua_KContext']
// 64 bit, and the module is built with WASM_BIGINT, so these cross as BigInt.
const BIGINTS = ['lua_Integer', 'lua_Unsigned']
const NULLABLE_FUNCTION_POINTERS = ['lua_KFunction', 'lua_Reader', 'lua_Writer', 'lua_Alloc', 'lua_Hook', 'lua_WarnFunction']

function paramType(type) {
    if (type === 'lua_State*') return 'LuaAddress'
    if (type === 'char*') return 'string | null'
    if (NUMBERS.includes(type) || type === 'lua_CFunction') return 'number'
    if (BIGINTS.includes(type)) return 'bigint'
    if (type.endsWith('*') || NULLABLE_FUNCTION_POINTERS.includes(type)) return 'number | null'
    throw new Error(`no binding type for a '${type}' parameter`)
}

function returnType(type, name) {
    if (RETURNS_TYPE.includes(name)) return 'LuaType'
    if (RETURNS_STATUS.includes(name)) return 'LuaReturn'
    if (type === 'void') return 'void'
    if (type === 'char*') return 'string'
    if (type === 'lua_State*' || type === 'void*') return 'LuaAddress'
    if (NUMBERS.includes(type) || type === 'lua_CFunction' || NULLABLE_FUNCTION_POINTERS.includes(type)) return 'number'
    if (BIGINTS.includes(type)) return 'bigint'
    throw new Error(`no binding type for a '${type}' return`)
}

/** `const char *s` as `{ type: 'char*', name: 's' }`. */
function parseSymbol(symbol) {
    const words = symbol
        .replace(/\bconst\b/g, '')
        .replace(/\*/g, ' * ')
        .trim()
        .split(/\s+/)
    const name = words.at(-1) === '*' || words.length === 1 ? undefined : words.pop()
    return { type: words.join(''), name }
}

/** Every function a header declares with LUA_API, LUALIB_API or LUAMOD_API. */
function parseHeader(file) {
    const statements = readFileSync(resolve(rootdir, 'lua', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\\\n/g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join(' ')
        .split(';')

    const functions = []
    for (const statement of statements) {
        const match = /^\s*(?:LUA|LUALIB|LUAMOD)_API\s+(.+?)\(?\b(\w+)\)?\s*\((.*)\)\s*$/.exec(statement)
        if (!match) {
            continue
        }
        const [, returns, name, params] = match
        functions.push({
            name,
            returns: parseSymbol(`${returns} ${name}`).type,
            variadic: /\.\.\.|\bva_list\b/.test(params),
            params: params.trim() === 'void' ? [] : params.split(',').map(parseSymbol),
        })
    }
    return functions
}

/** The functions src/native/wasmoon.c defines for the JS side, all of which are exported. */
function parseNativeExports() {
    const source = readFileSync(resolve(rootdir, 'src/native/wasmoon.c'), 'utf8')
    return [...source.matchAll(/^(?!static\b)\w[\w \t*]*?\b(wasmoon_\w+)\s*\(/gm)].map((match) => match[1])
}

const nativeExports = parseNativeExports()
const declared = HEADERS.flatMap(parseHeader)

for (const name of [...SKIPPED, ...HANDWRITTEN, ...RETURNS_TYPE, ...RETURNS_STATUS, ...Object.keys(OVERRIDES)]) {
    if (!declared.some((fn) => fn.name === name)) {
        // A function Lua renamed or removed would otherwise leave its special case behind unnoticed.
        throw new Error(`create-bindings lists '${name}', which the Lua headers no longer declare`)
    }
}

const exported = declared.filter((fn) => !SKIPPED.includes(fn.name) && (!fn.variadic || HANDWRITTEN.includes(fn.name)))
const bound = exported.filter((fn) => !HANDWRITTEN.includes(fn.name))

const declarations = []
const assignments = []
for (const fn of bound) {
    const override = OVERRIDES[fn.name] ?? {}
    for (const param of fn.params) {
        if (!param.name) {
            throw new Error(`${fn.name} declares a parameter with no name`)
        }
    }

    // A number that is a safe integer goes to the double taking twin in src/native/wasmoon.c.
    const integerTwin = fn.params.at(-1)?.type === 'lua_Integer' && nativeExports.includes(fn.name.replace('lua_', 'wasmoon_'))
    const params = fn.params.map((param, index) => {
        const type = override.params?.[param.name] ?? paramType(param.type)
        return `${param.name}: ${integerTwin && index === fn.params.length - 1 ? 'number | bigint' : type}`
    })
    declarations.push(`    declare public ${fn.name}: (${params.join(', ')}) => ${override.returns ?? returnType(fn.returns, fn.name)}`)

    // `s` marks a C string, in the return position first; see LuaModule.wrapWithStringArguments.
    const signature =
        override.signature ?? [fn.returns, ...fn.params.map((param) => param.type)].map((type) => (type === 'char*' ? 's' : 'n')).join('')
    if (integerTwin) {
        assignments.push(`        this.${fn.name} = this.withIntegerArgument('${fn.name}'${fn.params.length === 2 ? ', true' : ''})`)
    } else if (signature.includes('s') && !override.raw) {
        assignments.push(`        this.${fn.name} = this.wrapWithStringArguments(this.exported('${fn.name}'), '${signature}')`)
    } else {
        assignments.push(`        this.${fn.name} = this.exported('${fn.name}')`)
    }
}

const bindings = `// Generated by utils/create-bindings.js from ${HEADERS.map((header) => `lua/${header}`).join(', ')}.
// Do not edit: change the generator instead, and run it with \`node utils/create-bindings.js\`.
import type { LuaEmscriptenModule } from './module'
import type { LuaAddress, LuaReturn, LuaType } from './types'

type Binding = (...args: any[]) => any

/**
 * The Lua C API, one binding for each function the wasm module exports. A binding that marshals a
 * string or takes a lua_Integer is wrapped over the raw export; every other one crosses only
 * numbers and is the export itself.
 */
export default abstract class LuaBindings {
    public emscripten: LuaEmscriptenModule

${declarations.join('\n')}

    // Named stores in the constructor, rather than a loop over the names: that is what lets the
    // engine lay the bindings out as fixed fields of the instance, which every call reads one of.
    protected constructor(emscripten: LuaEmscriptenModule) {
        this.emscripten = emscripten

${assignments.join('\n')}
    }

    /** The wasm export \`name\`. */
    protected abstract exported(name: string): Binding
    protected abstract wrapWithStringArguments(raw: Binding, signature: string): Binding
    protected abstract withIntegerArgument(name: string, twoArguments?: boolean): Binding
}
`

const exportedFunctions = ['malloc', 'free', 'realloc', ...exported.map((fn) => fn.name), ...nativeExports].map((name) => `_${name}`)

mkdirSync(resolve(rootdir, 'build'), { recursive: true })
writeFileSync(resolve(rootdir, BINDINGS_FILE), bindings)
writeFileSync(resolve(rootdir, EXPORTS_FILE), `${JSON.stringify(exportedFunctions, null, 4)}\n`)
console.log(`create-bindings: ${bound.length} bindings in ${BINDINGS_FILE}, ${exportedFunctions.length} exports in ${EXPORTS_FILE}`)
