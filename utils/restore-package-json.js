import { copyFileSync, rmSync } from 'node:fs'

const packagePath = new URL('../package.json', import.meta.url)
const backupPath = new URL('../package.json.autoresearch-backup', import.meta.url)
copyFileSync(backupPath, packagePath)
rmSync(backupPath, { force: true })
