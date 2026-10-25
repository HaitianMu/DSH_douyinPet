#!/usr/bin/env node
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const walk = (folder) => readdirSync(join(root, folder), { withFileTypes: true }).flatMap((entry) => {
  const path = join(folder, entry.name)
  return entry.isDirectory() ? walk(path) : /\.(?:js|mjs)$/.test(path) ? [path] : []
})
const files = ['index.js', 'client.js', ...walk('lib'), ...walk('test'), 'tools/check.mjs', 'tools/memory.mjs', 'tools/selftest.mjs']
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) {
    process.stderr.write(`${file}: ${result.error?.message || result.stderr}\n`)
    process.exitCode = 1
  }
}
if (!process.exitCode) process.stdout.write(`Syntax OK: ${files.length} files\n`)
