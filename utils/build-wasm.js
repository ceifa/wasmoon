import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

const isUnix = process.platform !== 'win32'
const rootdir = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)

const execute = (command) => {
    console.log(`Running: ${command}`)
    try {
        execSync(command, { stdio: 'inherit' })
    } catch (error) {
        console.error(`Error running command: ${command}`)
        process.exit(1)
    }
}

execute('git submodule update --init --recursive')

if (isUnix) {
    let emccInstalled = false
    try {
        const version = execSync('emcc --version', { encoding: 'utf-8' })
        console.log('Emscripten is installed:', version)

        emccInstalled = true
    } catch (error) {
        console.error('Emscripten is not installed or not in your PATH. Will try to build using Docker.')
    }

    if (emccInstalled) {
        const command = `${resolve(rootdir, 'utils/build-wasm.sh')} ${args.join(' ')}`
        execute(command)

        process.exit(0)
    }
}

const dockerVolume = `${rootdir}:/wasmoon`
const command = `docker run --rm -v "${dockerVolume}" emscripten/emsdk /wasmoon/utils/build-wasm.sh ${args.join(' ')}`

execute(command)
