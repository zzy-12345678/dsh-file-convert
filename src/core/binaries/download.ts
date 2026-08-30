import { createHash, timingSafeEqual } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { execTool } from '../utils/exec.js'
import { cachedBinaryPath } from './cache.js'
import type { BinaryDependency } from '../types.js'

/**
 * Where each external binary comes from when the machine has none: pinned
 * single-binary FFmpeg 6.1.1 builds from the ffmpeg-static project, served by
 * the npmmirror binary CDN first (fast and reachable where GitHub-style hosts
 * may not be) with the GitHub release as fallback. Both mirrors serve
 * byte-identical files validated against the pinned sha256 below. Bump the
 * version deliberately and re-pin the hashes; never resolve to "latest".
 */
const FFMPEG_STATIC_VERSION = 'b6.1.1' // FFmpeg 6.1.1

const FFMPEG_STATIC_MIRRORS = [
  (asset: string) => `https://registry.npmmirror.com/-/binary/ffmpeg-static/${FFMPEG_STATIC_VERSION}/${asset}.gz`,
  (asset: string) => `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_VERSION}/${asset}.gz`,
]

/** asset name (without .gz) and its pinned sha256, per binary per platform.
 * Hashes were computed from the npmmirror-mirrored b6.1.1 assets; the GitHub
 * release fallback serves byte-identical files. */
const STATIC_BINS: Record<string, { asset: string; sha256: string }> = {
  'ffmpeg:win32-x64': {
    asset: 'ffmpeg-win32-x64',
    sha256: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
  },
  'ffprobe:win32-x64': {
    asset: 'ffprobe-win32-x64',
    sha256: 'f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d',
  },
  'ffmpeg:darwin-arm64': {
    asset: 'ffmpeg-darwin-arm64',
    sha256: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
  },
  'ffprobe:darwin-arm64': {
    asset: 'ffprobe-darwin-arm64',
    sha256: 'd986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be',
  },
  'ffmpeg:darwin-x64': {
    asset: 'ffmpeg-darwin-x64',
    sha256: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
  },
  'ffprobe:darwin-x64': {
    asset: 'ffprobe-darwin-x64',
    sha256: 'd4da574d6e2e197bd259b47d69cf262df9e312af24ad960444f6d806d3d4c186',
  },
  'ffmpeg:linux-x64': {
    asset: 'ffmpeg-linux-x64',
    sha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
  },
  'ffprobe:linux-x64': {
    asset: 'ffprobe-linux-x64',
    sha256: '25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067',
  },
}

export class DownloadError extends Error {
  constructor(
    readonly code: 'unsupported_platform' | 'integrity' | 'network' | 'verify_failed',
    message: string,
  ) {
    super(message)
  }
}

export interface DownloadOutcome {
  path: string
  bytes: number
  /** First line of `<binary> -version`, e.g. "ffmpeg version 6.1.1 ...". */
  versionLine: string
}

/**
 * Download one external binary into the plugin cache. Mirrors are tried in
 * order; the gzip is sha256-verified before decompression, and the binary is
 * proven by actually running `-version` once before success is reported.
 */
export async function downloadBinary(
  dep: BinaryDependency,
  opts: { timeoutMs: number; signal?: AbortSignal; force?: boolean },
): Promise<DownloadOutcome> {
  const target = cachedBinaryPath(dep.name)
  if (!opts.force && (await fileExists(target))) {
    return { path: target, bytes: (await fs.stat(target)).size, versionLine: 'already cached' }
  }

  const platformKey = `${process.platform}-${process.arch}`
  const entry = STATIC_BINS[`${dep.name}:${platformKey}`]
  if (!entry) {
    throw new DownloadError('unsupported_platform', `No prebuilt ${dep.name} for ${platformKey}; install it manually.`)
  }

  const errors: string[] = []
  for (const mirror of FFMPEG_STATIC_MIRRORS) {
    const url = mirror(entry.asset)
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-file-convert-dl-'))
    try {
      const gzPath = path.join(tmpDir, 'bin.gz')
      const bytes = await downloadTo(url, gzPath, opts.timeoutMs, opts.signal)
      verifyDigest(await fs.readFile(gzPath), entry.sha256)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, gunzipSync(await fs.readFile(gzPath)))
      if (process.platform !== 'win32') await fs.chmod(target, 0o755)
      const { stdout, stderr } = await execTool(target, ['-version'], { timeoutMs: 15_000, signal: opts.signal })
      const versionLine = (stdout || stderr).split(/\r?\n/, 1)[0]?.trim() ?? ''
      return { path: target, bytes, versionLine }
    } catch (err) {
      errors.push(`${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`)
      // either mirror may be unreachable; the pinned digest protects us either way
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  throw new DownloadError('network', `All mirrors failed for ${dep.name}: ${errors.join(' | ')}`)
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

function verifyDigest(data: Buffer, expectedSha256Hex: string): void {
  const actual = createHash('sha256').update(data).digest('hex').toLowerCase()
  const wanted = expectedSha256Hex.toLowerCase()
  const a = Buffer.from(actual)
  const b = Buffer.from(wanted)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new DownloadError('integrity', `Checksum mismatch: downloaded binary does not match its pinned sha256.`)
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
