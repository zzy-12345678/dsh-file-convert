import { createHash, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { execTool } from '../utils/exec.js'
import { cachedBinaryPath, cacheDir } from './cache.js'
import type { BinaryDependency } from '../types.js'

/**
 * Where each external binary comes from when the machine has none.
 * Sources are npm packages whose tarball CONTAINS the binary, served by the
 * npm registry: the packument's dist.integrity (sha512) is verified before
 * extraction, and the registry is reachable where GitHub releases may not be.
 * Bump the pinned versions deliberately; never resolve to "latest".
 */
const NPM_SOURCES: Record<string, { pkg: string; version: string }> = {
  'ffmpeg:win32-x64': { pkg: '@ffmpeg-installer/win32-x64', version: '4.1.0' },
  'ffmpeg:darwin-arm64': { pkg: '@ffmpeg-installer/darwin-arm64', version: '4.1.5' },
  'ffmpeg:darwin-x64': { pkg: '@ffmpeg-installer/darwin-x64', version: '4.1.0' },
  'ffmpeg:linux-x64': { pkg: '@ffmpeg-installer/linux-x64', version: '4.1.0' },
  'ffprobe:win32-x64': { pkg: '@ffprobe-installer/win32-x64', version: '5.1.0' },
  'ffprobe:darwin-x64': { pkg: '@ffprobe-installer/darwin-x64', version: '5.1.0' },
  'ffprobe:linux-x64': { pkg: '@ffprobe-installer/linux-x64', version: '5.2.0' },
}

export class DownloadError extends Error {
  constructor(
    readonly code: 'unsupported_platform' | 'no_source_version' | 'integrity' | 'network' | 'not_found' | 'verify_failed',
    message: string,
  ) {
    super(message)
  }
}

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const CN_FALLBACK_REGISTRY = 'https://registry.npmmirror.com'

/**
 * Registries to try, in order. Default is the CN mirror first (it serves the
 * same integrity-verified tarballs and is reachable where npmjs can be slow
 * or blocked); explicit tool parameter wins over everything.
 */
function registryChain(explicit: string | undefined): string[] {
  if (explicit) return [explicit.replace(/\/$/, '')]
  const fromEnv = process.env.npm_config_registry?.replace(/\/$/, '')
  const chain = [fromEnv ?? CN_FALLBACK_REGISTRY, CN_FALLBACK_REGISTRY, DEFAULT_REGISTRY]
  return [...new Set(chain)]
}

export interface DownloadOutcome {
  path: string
  bytes: number
  /** First line of `<binary> -version`, e.g. "ffmpeg version 6.1.1 ...". */
  versionLine: string
}

/**
 * Download one external binary into the plugin cache. On success the binary
 * is verified by actually running `-version` once.
 */
export async function downloadBinary(
  dep: BinaryDependency,
  opts: { timeoutMs: number; signal?: AbortSignal; force?: boolean; registry?: string },
): Promise<DownloadOutcome> {
  const target = cachedBinaryPath(dep.name)
  if (!opts.force && (await fileExists(target))) {
    return { path: target, bytes: (await fs.stat(target)).size, versionLine: 'already cached' }
  }

  const platformKey = `${process.platform}-${process.arch}`
  const source = NPM_SOURCES[`${dep.name}:${platformKey}`]
  if (!source) {
    throw new DownloadError('unsupported_platform', `No prebuilt ${dep.name} for ${platformKey}; install it manually.`)
  }

  const registries = registryChain(opts.registry)
  const signal = opts.signal
  const errors: string[] = []
  let version: { dist: { tarball: string; integrity: string } } | undefined

  // 1. Packument from the first registry that answers.
  for (const registry of registries) {
    try {
      const packument = await fetchJson<any>(`${registry}/${encodeURIComponent(source.pkg)}`, opts.timeoutMs, signal)
      const candidate = packument?.versions?.[source.version]
      if (!candidate?.dist?.tarball || !candidate?.dist?.integrity) {
        throw new DownloadError('no_source_version', `${source.pkg}@${source.version} not found on ${registry}.`)
      }
      version = candidate
      break
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  if (!version) {
    throw new DownloadError('network', `All registries failed for ${source.pkg}: ${errors.join(' | ')}`)
  }

  // 2. Download the tarball (mirror packuments point at their own CDN).
  await fs.mkdir(cacheDir(), { recursive: true })
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-file-convert-dl-'))
  const tarball = path.join(tmpDir, 'pkg.tgz')
  try {
    const bytes = await downloadTo(version.dist.tarball, tarball, opts.timeoutMs, signal)

    // 3. Registry integrity (SRI: "sha512-<base64>").
    const expected = String(version.dist.integrity)
    const [algorithm, expectedDigest] = expected.split('-', 2)
    if (algorithm !== 'sha512') {
      throw new DownloadError('integrity', `Unsupported integrity algorithm: ${algorithm}`)
    }
    verifyDigest(await fs.readFile(tarball), 'sha512', expectedDigest)

    // 4. Extract and locate the binary inside the package.
    const extractDir = path.join(tmpDir, 'pkg')
    await fs.mkdir(extractDir, { recursive: true })
    const { x: extractTar } = await import('tar')
    await extractTar({ file: tarball, cwd: extractDir })
    const binaryName = dep.name + (process.platform === 'win32' ? '.exe' : '')
    const found = await findFile(extractDir, binaryName)
    if (!found) {
      throw new DownloadError('not_found', `${binaryName} not found inside ${source.pkg}@${source.version}.`)
    }

    // 5. Install into the cache and make it executable.
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(found, target)
    if (process.platform !== 'win32') await fs.chmod(target, 0o755)

    // 6. Prove it runs.
    const { stdout, stderr } = await execTool(target, ['-version'], { timeoutMs: 15_000, signal })
    const versionLine = (stdout || stderr).split(/\r?\n/, 1)[0]?.trim() ?? ''
    return { path: target, bytes, versionLine }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function fetchJson<T>(url: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(Math.min(timeoutMs, 30_000)), ...(signal ? [signal] : [])]) })
  } catch (err) {
    throw new DownloadError('network', `Cannot reach the npm registry (${url}): ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) {
    throw new DownloadError('network', `Registry returned HTTP ${res.status} for ${url}`)
  }
  return (await res.json()) as T
}

async function downloadTo(url: string, target: string, timeoutMs: number, signal?: AbortSignal): Promise<number> {
  let res: Response
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) })
  } catch (err) {
    throw new DownloadError('network', `Download failed (${url}): ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok || !res.body) {
    throw new DownloadError('network', `Download returned HTTP ${res.status} for ${url}`)
  }
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(target))
  return (await fs.stat(target)).size
}

function verifyDigest(data: Buffer, algorithm: string, expectedBase64: string): void {
  const actual = createHash(algorithm).update(data).digest('base64')
  const a = Buffer.from(actual)
  const b = Buffer.from(expectedBase64)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new DownloadError('integrity', `Checksum mismatch: downloaded archive does not match the registry's ${algorithm} integrity.`)
  }
}

async function findFile(dir: string, fileName: string): Promise<string | null> {
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name === fileName) return full
    }
  }
  return null
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
