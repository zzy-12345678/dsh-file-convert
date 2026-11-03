import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { validateRelease } from './check-release.mjs'

export function validatePublishedPackage(manifest, published, commit) {
  if (published.name !== manifest.name || published.version !== manifest.version || published.gitHead !== commit) {
    throw new Error('The existing npm version belongs to a different package or commit; refusing to overwrite or skip it.')
  }
}

async function fetchRetry(url, options = {}) {
  if (options.method === 'POST') return fetch(url, { ...options, signal: AbortSignal.timeout(20_000) })
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) })
      if (attempt === 2 || (response.status !== 429 && response.status < 500)) return response
      await response.body?.cancel()
    } catch (error) {
      if (attempt === 2) throw error
    }
    await delay(1000 * (attempt + 1))
  }
}

export async function npmState(manifest, commit, get = fetchRetry) {
  const response = await get(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`)
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`npm lookup failed: HTTP ${response.status}`)
  validatePublishedPackage(manifest, await response.json(), commit)
  return true
}

export async function ensureRelease(repository, tag, token, { get = fetchRetry, sleep = delay } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository name.')
  const base = `https://api.github.com/repos/${repository}/releases`
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'dsh-file-convert-release', Accept: 'application/vnd.github+json' }
  for (let attempt = 0; attempt < 3; attempt++) {
    // Recheck after a failed POST: the server may have created the release
    // even if its response was lost. Never create it twice.
    const existing = await get(`${base}/tags/${encodeURIComponent(tag)}`, { headers })
    if (existing.ok) {
      const release = await existing.json()
      if (release.draft || release.tag_name !== tag) throw new Error('Existing release is a draft or has an unexpected tag.')
      return release.html_url
    }
    if (existing.status !== 404) throw new Error(`GitHub release lookup failed: HTTP ${existing.status}`)
    let response
    try {
      // POST is retried by the surrounding loop, always after a GET.
      response = await get(base, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_name: tag, name: tag, generate_release_notes: true }),
      })
    } catch (error) {
      if (attempt === 2) throw error
    }
    if (response?.ok) {
      const release = await response.json()
      return release.html_url
    }
    if (response && ![422, 429].includes(response.status) && response.status < 500) {
      throw new Error(`GitHub release creation failed: HTTP ${response.status}`)
    }
    if (attempt === 2) throw new Error(`GitHub release creation failed after retries: HTTP ${response?.status ?? 'network error'}`)
    await sleep(1000 * (attempt + 1))
  }
}

async function main() {
  const [mode, tag] = process.argv.slice(2)
  if (!['npm', 'github'].includes(mode) || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag ?? '')) {
    throw new Error('Usage: release-state.mjs npm|github v<version>')
  }
  const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'))
  const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'))
  validateRelease(manifest, lock, tag)
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const taggedCommit = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim()
  if (commit !== taggedCommit) throw new Error('Checkout HEAD does not match the release tag.')
  if (mode === 'npm') {
    const published = await npmState(manifest, commit)
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `published=${published}\n`)
    console.log(published ? `Verified ${manifest.name}@${manifest.version} is already published from ${commit}; skipping npm publish.` : 'Version is not published yet.')
  } else {
    if (!process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY) throw new Error('Missing GitHub credentials or repository.')
    console.log(await ensureRelease(process.env.GITHUB_REPOSITORY, tag, process.env.GH_TOKEN))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
