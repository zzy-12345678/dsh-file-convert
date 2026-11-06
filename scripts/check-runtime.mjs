import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// Run the same source against a separate, complete older peer graph. Changing
// only dsh-tools in node_modules would mix incompatible host runtimes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run this check with npm run test:compat.')
const runtime = '0.2.1-rc.5'
const tempRoot = path.resolve(os.tmpdir())
const work = await fs.mkdtemp(path.join(tempRoot, 'dsh-file-convert-compat-'))
function run(args) {
  const result = spawnSync(process.execPath, [npm, ...args], { cwd: work, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${result.status ?? result.signal}). Workspace: ${work}`)
}
let passed = false
try {
  for (const name of ['src', 'tests', 'scripts', 'tsconfig.json', 'vitest.config.ts', '.npmrc']) {
    await fs.cp(path.join(root, name), path.join(work, name), { recursive: true })
  }
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  for (const name of Object.keys(manifest.devDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) manifest.devDependencies[name] = runtime
  }
  manifest.devDependencies['@deepseek-ai/cordis'] = '4.0.5'
  await fs.writeFile(path.join(work, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  // check-release verifies these metadata files during npm test.
  run(['install', '--no-audit', '--no-fund'])
  run(['test'])
  run(['run', 'smoke'])
  passed = true
  console.log(`Full compatibility check passed on DSH ${runtime}.`)
} finally {
  // Keep failures for diagnosis; validate the absolute target before cleanup.
  if (passed && path.dirname(work) === tempRoot && path.basename(work).startsWith('dsh-file-convert-compat-')) {
    await fs.rm(work, { recursive: true, force: true, maxRetries: 3 })
  }
}
