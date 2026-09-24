import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distFile = resolve(__dirname, '..', 'dist', 'mock-server.js')
const shebang = '#!/usr/bin/env node\n'

const content = readFileSync(distFile, 'utf-8')
if (!content.startsWith('#!')) {
  writeFileSync(distFile, shebang + content)
}
chmodSync(distFile, 0o755)
console.log('✓ shebang injected & chmod +x dist/mock-server.js')