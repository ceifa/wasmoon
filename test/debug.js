import { getEngine } from './utils.js'

// This file was created as a sandbox to test and debug on vscode
const engine = await getEngine()
engine.global.set('potato', {
    test: true,
    hello: ['world'],
})
engine.global.get('potato')
engine.doStringSync('print(potato.hello[1])')
