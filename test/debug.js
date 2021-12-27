const { getEngine } = require('./utils')

// This is a file was created as a sandbox to test and debug on vscode
;(async () => {
    const engine = await getEngine()
    engine.global.set('potato', {
        test: true,
        hello: ['world'],
    })
    engine.global.get('potato')
    engine.doStringSync('print(potato.hello[1])')
})().catch(console.error)
