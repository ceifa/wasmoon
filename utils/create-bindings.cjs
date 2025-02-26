#!/usr/bin/env node

const readline = require('readline')
const fs = require('fs')

const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
})

String.prototype.replaceAll = function (str, newStr) {
    return this.split(str).join(newStr)
}

const allFunctions = []
const types = []

const functionPointerTypes = ['lua_KFunction', 'lua_Reader', 'lua_Writer', 'lua_Alloc', 'lua_Hook', 'lua_WarnFunction']

const bindingTypes = {
    'void': null,
    'lua_State*': 'number',
    'lua_Number': 'number',
    'size_t': 'number',
    'int': 'number',
    'char*': 'string',
    'size_t*': 'number',
    'lua_Integer': 'number',
    'void*': 'number',
    'luaL_Buffer*': 'number',
    'luaL_Reg*': 'number',
    'lua_CFunction': 'number',
    'int*': 'number',
    'lua_Unsigned': 'number',
    'lua_KContext': 'number',
    'lua_Debug*': 'number',
}

const typescriptTypes = {
    'void': 'void',
    'lua_State*': 'LuaState',
    'lua_Number': 'number',
    'size_t': 'number',
    'int': 'number',
    'char*': 'string',
    'size_t*': 'number',
    'lua_Integer': 'number',
    'void*': 'number',
    'luaL_Buffer*': 'number',
    'luaL_Reg*': 'number',
    'lua_CFunction': 'number',
    'int*': 'number',
    'lua_Unsigned': 'number',
    'lua_KContext': 'number',
    'lua_Debug*': 'number',
}

const functionsThatReturnType = [
    'lua_getfield',
    'lua_getglobal',
    'lua_geti',
    'lua_gettable',
    'lua_getiuservalue',
    'lua_rawgeti',
    'lua_rawgetp',
    'lua_type',
    'luaL_getmetafield',
    'luaL_getmetatable',
]

const functionsThatReturnState = [
    'lua_load',
    'lua_pcall',
    'lua_resetthread',
    'lua_resume',
    'lua_status',
    'luaL_dofile',
    'luaL_dostring',
    'luaL_loadbuffer',
    'luaL_loadbufferx',
    'luaL_loadfile',
    'luaL_loadfilex',
    'luaL_loadstring',
]

const bannedFunctions = [
    // Not a defined function in our builds.
    'debug_realloc',
    // Accepts string array
    'luaL_checkoption',
    'luaB_opentests',
]

function mapTsType(type, name) {
    if (name && functionsThatReturnType.includes(name)) {
        return 'LuaType'
    }
    if (name && functionsThatReturnState.includes(name)) {
        return 'LuaReturn'
    }
    const mapped = typescriptTypes[type]
    if (mapped === undefined) {
        throw new Error('missing ts mapping')
    }
    if (type.endsWith('*') && mapped !== 'LuaState' && !name) {
        // Pointers can be null, cast to nullptr.
        return `${mapped} | null`
    }
    return mapped
}

function parseNamedSymbol(symbol) {
    const isPointer = symbol.includes('*')

    const [type, name] = symbol
        .replaceAll('const', '')
        .replaceAll('unsigned', '')
        .replaceAll('*', '')
        .split(' ')
        .map((val) => val.trim())
        .filter((val) => !!val)
    if (functionPointerTypes.includes(type)) {
        return { type: 'void*', name }
    }
    const saneType = isPointer ? `${type}*` : type
    types.push(saneType)

    return { type: saneType, name }
}

function parseLine(line) {
    const argStart = line.lastIndexOf('(')
    if (argStart < 0) {
        console.warn('Cannot find parameters on line', line)
        return undefined
    }
    const starter = line.substring(0, argStart)
    const retPlusSymbol = starter.substring(line.indexOf(' ')).replaceAll('(', ' ').replaceAll(')', '')
    const rawArgs = line.substring(argStart).substring(1).split(')')[0].split(',')
    return {
        definition: parseNamedSymbol(retPlusSymbol),
        args: rawArgs.map((arg) => parseNamedSymbol(arg)).filter((arg) => arg.type !== 'void'),
    }
}

rl.on('line', (file) => {
    const rawFile = fs.readFileSync(file).toString()

    const statements = rawFile
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
        .replaceAll('\\\n', '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n')
        .split(';')
        .map((statement) => statement.trim())
    const apiStatements = statements
        .filter((statement) => {
            const starter = statement.trim().split(' ')[0]
            return starter.includes('_API')
        })
        .map((statement) => statement.replaceAll('\n', ''))
    allFunctions.push(...apiStatements.map((statement) => parseLine(statement)).filter((statement) => !!statement))
})

rl.on('close', () => {
    const bindings = allFunctions
        .map((fn) => {
            try {
                if (bannedFunctions.includes(fn.definition.name)) {
                    throw new Error('skipping banned function')
                }
                const argArray = fn.args.map((arg) => {
                    const type = bindingTypes[arg.type]
                    if (type === undefined) {
                        throw new Error('missing binding type')
                    }
                    if (!arg.name) {
                        throw new Error('missing argument name')
                    }
                    return type === null ? null : `'${type}'`
                })
                const returnType = bindingTypes[fn.definition.type]
                if (returnType === undefined) {
                    throw new Error('missing binding return type')
                }
                const quotedReturn = returnType === null ? null : `'${returnType}'`
                const binding = `this.${fn.definition.name} = this.module.cwrap('${fn.definition.name}', ${quotedReturn}, [${argArray.join(
                    ', ',
                )}])`

                // public lua_newstate: (allocatorFunction: number, userData: number | null) => LuaState
                const tsParams = fn.args.map((arg) => {
                    let mapped = mapTsType(arg.type)
                    if (fn.definition.name === 'lua_resume' && arg.name === 'from') {
                        mapped = `${mapped} | null`
                    }
                    return `${arg.name}: ${mapped}`
                })
                const tsReturn = mapTsType(fn.definition.type, fn.definition.name)
                const header = `public ${fn.definition.name}: (${tsParams.join(', ')}) => ${tsReturn}`

                const sh = `        '_${fn.definition.name}', \\`

                return { binding, header, sh }
            } catch (err) {
                console.warn(err.message, fn)
                return undefined
            }
        })
        .filter((val) => !!val)

    console.log(bindings.map((binding) => binding.binding).join('\n'))
    console.log('\n\n')
    console.log(bindings.map((binding) => binding.header).join('\n'))
    console.log('\n\n')
    console.log(bindings.map((binding) => binding.sh).join('\n'))

    console.log(Array.from(new Set(types)))
})
