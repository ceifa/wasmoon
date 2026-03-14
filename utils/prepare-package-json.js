import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const packagePath = new URL('../package.json', import.meta.url)
const backupPath = new URL('../package.json.autoresearch-backup', import.meta.url)
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
copyFileSync(packagePath, backupPath)
writeFileSync(
    packagePath,
    JSON.stringify({
        name: pkg.name,
        version: pkg.version,
        type: pkg.type,
        main: pkg.main,
        types: pkg.types,
        bin: pkg.bin,
        license: pkg.license,
        dependencies: pkg.dependencies,
        files: pkg.files,
    }) + '\n',
)
