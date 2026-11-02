import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export function validateRelease(manifest, lock, tag) {
  if (lock.name !== manifest.name || lock.version !== manifest.version ||
      lock.packages?.['']?.version !== manifest.version) {
    throw new Error('package.json and package-lock.json must have the same name and version.')
  }
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const expected = manifest[key] ?? {}
    const actual = lock.packages?.['']?.[key] ?? {}
    const names = new Set([...Object.keys(expected), ...Object.keys(actual)])
    for (const name of names) {
      if (expected[name] !== actual[name]) {
        throw new Error(`Lockfile mismatch: ${key}.${name}; run npm install with the pinned npm version.`)
      }
    }
  }
  if (tag && tag !== `v${manifest.version}`) {
    throw new Error(`Tag ${tag} does not match package version ${manifest.version}.`)
  }
}

export async function assertUnpublished(name, version, fetchImpl = fetch) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
  let response
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) })
      if (response.status !== 429 && response.status < 500) break
      if (attempt === 2) break
    } catch (error) {
      if (attempt === 2) {
        throw new Error(`Cannot verify npm publication status: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`, { cause: error })
      }
    }
    await delay(500 * (attempt + 1))
  }
  if (response.status === 404) return
  if (response.ok) throw new Error(`${name}@${version} is already published; choose a new version.`)
  throw new Error(`Cannot verify npm publication status: HTTP ${response.status}.`)
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'))
  const args = process.argv.slice(2)
  const tagIndex = args.indexOf('--tag')
  if (tagIndex >= 0 && (!args[tagIndex + 1] || args[tagIndex + 1].startsWith('--'))) {
    throw new Error('--tag requires a version tag.')
  }
  const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined
  validateRelease(manifest, lock, tag)
  if (args.includes('--check-registry')) await assertUnpublished(manifest.name, manifest.version)
  console.log(`Release metadata OK: ${manifest.name}@${manifest.version}${tag ? ` (${tag})` : ''}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
