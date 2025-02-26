import { getState } from './utils.js'

// This file was created as a sandbox to test and debug on vscode
const state = await getState()
state.global.set('potato', {
    test: true,
    hello: ['world'],
})
state.global.get('potato')
state.doStringSync('print(potato.hello[1])')
