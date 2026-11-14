import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// Run the same source against each supported older peer graph. Changing only
// dsh-tools in node_modules would mix incompatible host runtimes, so every
// runtime gets its own isolated install, build, test and smoke run.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run this check with npm run test:compat.')
const runtimes = [
  { dsh: '0.2.1-rc.5', cordis: '4.0.5' },
  { dsh: '0.2.2-rc.1', cordis: '4.1.0' },
]
const tempRoot = path.resolve(os.tmpdir())
function run(args, work) {
  const result = spawnSync(process.execPath, [npm, ...args], { cwd: work, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${result.status ?? result.signal}). Workspace: ${work}`)
}
const failures = []
for (const runtime of runtimes) {
  const work = await fs.mkdtemp(path.join(tempRoot, `dsh-file-convert-compat-${runtime.dsh}-`))
  let passed = false
  try {
    for (const name of ['src', 'tests', 'scripts', 'tsconfig.json', 'vitest.config.ts', '.npmrc']) {
      await fs.cp(path.join(root, name), path.join(work, name), { recursive: true })
    }
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    for (const name of Object.keys(manifest.devDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) manifest.devDependencies[name] = runtime.dsh
    }
    manifest.devDependencies['@deepseek-ai/cordis'] = runtime.cordis
    await fs.writeFile(path.join(work, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    // check-release verifies these metadata files during npm test.
    run(['install', '--no-audit', '--no-fund'], work)
    run(['test'], work)
    run(['run', 'smoke'], work)
    passed = true
    console.log(`Full compatibility check passed on DSH ${runtime.dsh}.`)
  } catch (error) {
    failures.push(`DSH ${runtime.dsh}: ${error.message}`)
    console.error(`Compatibility check failed on DSH ${runtime.dsh}: ${error.message}`)
  } finally {
    // Keep failures for diagnosis; validate the absolute target before cleanup.
    if (passed && path.dirname(work) === tempRoot && path.basename(work).startsWith(`dsh-file-convert-compat-${runtime.dsh}-`)) {
      await fs.rm(work, { recursive: true, force: true, maxRetries: 3 })
    }
  }
}
if (failures.length > 0) {
  throw new Error(`Compatibility check failed for: ${failures.join(' | ')}`)
}
console.log(`Full compatibility check passed on all ${runtimes.length} older runtimes.`)
