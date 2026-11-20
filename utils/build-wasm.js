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
// On the host rather than in the script below, which may run in a container: what it writes into
// src/ would belong to that container's user.
execute(`node "${resolve(rootdir, 'utils/create-bindings.js')}"`)

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

try {
    execSync('docker --version', { encoding: 'utf-8' })
} catch (error) {
    console.error('Docker is not installed or not in your PATH. Please install Docker to build the WASM file.')
    process.exit(1)
}

const dockerVolume = `${rootdir}:/wasmoon`
// Pinned to the version the workflows in .github/ install, so a local build makes the same glue CI
// tests rather than whatever `latest` is today.
const EMSDK_VERSION = '7.0.0'
const command = `docker run --rm -v "${dockerVolume}" emscripten/emsdk:${EMSDK_VERSION} /wasmoon/utils/build-wasm.sh ${args.join(' ')}`

execute(command)
