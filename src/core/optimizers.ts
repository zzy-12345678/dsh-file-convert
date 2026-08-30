import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { ExecError, execTool, probeMedia } from './utils/exec.js'
import { convertError } from './errors.js'
import { FFMPEG, FFPROBE } from './converters/media.js'
import type { BinaryDependency, ConvertContext, ConvertError, ConvertErrorCode, FormatId } from './types.js'

export const GHOSTSCRIPT: BinaryDependency = {
  name: 'ghostscript',
  displayName: 'Ghostscript',
  commands: ['gswin64c', 'gswin32c', 'gs'],
  configKey: 'ghostscriptPath',
  extraPaths: {
    // gs installs into a versioned directory and is not always on PATH
    win32: ['C:\\Program Files\\gs\\gs*\\bin\\gswin64c.exe'],
    darwin: ['/opt/homebrew/bin/gs', '/usr/local/bin/gs'],
    linux: ['/usr/bin/gs', '/usr/local/bin/gs'],
  },
  installHint: {
    win32: 'winget install ArtifexSoftware.GhostScript (or download from github.com/ArtifexSoftware/ghostpdl-downloads)',
    darwin: 'brew install ghostscript',
    linux: 'sudo apt install ghostscript',
  },
}

export type OptimizeResult =
  | {
      ok: true
      input: string
      output: string
      format: FormatId
      bytesIn: number
      bytesOut: number
      durationMs: number
      /** Human-readable summary of what was applied (bitrate, quality...). */
      detail: string
      warnings: string[]
    }
  | { ok: false; error: ConvertError }

export interface BinaryResolver {
  (dep: BinaryDependency): Promise<string | null>
}

const FFMPEG_GLOBAL = ['-hide_banner', '-nostdin', '-y']

/**
 * Shrink a file toward a target size, fully local.
 * - mp4/mov video: two-pass x264 with a bitrate computed from the target
 *   (output is always mp4; the container may change for MOV sources).
 * - jpg/webp: binary-search the largest encoder quality that fits.
 * - png: libimagequant palette search (lossy color reduction, by design).
 * GIF and PDF optimization are not supported yet (pdf planned with V0.3).
 */
export async function optimizeFile(
  input: string,
  targetBytes: number,
  output: string,
  format: FormatId,
  resolve: BinaryResolver,
  ctx: ConvertContext,
): Promise<OptimizeResult> {
  const started = Date.now()
  try {
    const bytesIn = (await fs.stat(input)).size
    let bytesOut: number
    let detail: string
    const warnings: string[] = []

    if (bytesIn <= targetBytes) {
      // Nothing to do: keep the source as the output so the caller always gets a file.
      await fs.copyFile(input, output)
      return {
        ok: true, input, output, format,
        bytesIn, bytesOut: bytesIn,
        durationMs: Date.now() - started,
        detail: `input (${bytesIn} bytes) is already below the target (${targetBytes} bytes); copied unchanged`,
        warnings: [],
      }
    }

    switch (format) {
      case 'mp4':
      case 'mov': {
        const applied = await optimizeVideo(input, targetBytes, output, resolve, ctx)
        detail = `two-pass x264: video ${applied.videoKbps}k + audio ${applied.audioKbps}k over ${applied.durationSec.toFixed(1)}s`
        break
      }
      case 'jpg':
      case 'webp': {
        const used = await optimizeQuality(input, targetBytes, output, format)
        detail = `${format} quality ${used}`
        break
      }
      case 'png': {
        const used = await optimizeQuality(input, targetBytes, output, 'png')
        detail = `png palette quality ${used}`
        warnings.push('PNG palette mode reduces the color count; compare visually.')
        break
      }
      case 'pdf': {
        const applied = await optimizePdf(input, targetBytes, output, resolve, ctx)
        detail = applied.detail
        warnings.push(...applied.warnings)
        break
      }
      case 'gif':
        return notPossible(input, format, 'GIF optimization is not supported yet.')
      default:
        return notPossible(input, format, `optimize_file supports mp4/mov video, jpg/webp/png images and pdf, not ${format}.`)
    }

    bytesOut = (await fs.stat(output)).size
    return { ok: true, input, output, format, bytesIn, bytesOut, durationMs: Date.now() - started, detail, warnings }
  } catch (err) {
    if (err instanceof OptimizeError) return { ok: false, error: err.error }
    if (err instanceof ExecError) {
      const code = err.code === 'timeout' ? 'timeout' : err.code === 'cancelled' ? 'cancelled' : 'conversion_failed'
      return { ok: false, error: convertError(code, `Optimization failed (ffmpeg).`, { detail: err.stderr }) }
    }
    return { ok: false, error: convertError('conversion_failed', `Optimization failed for ${input}`, {
      detail: err instanceof Error ? err.message : String(err),
    }) }
  }
}

class OptimizeError {
  constructor(readonly error: ConvertError) {}
}

function notPossible(input: string, format: FormatId, message: string): OptimizeResult {
  return {
    ok: false,
    error: convertError('unsupported_conversion', message, {
      hint: `Use convert_file for ${format} instead.`,
    }),
  }
}

interface VideoApplied { videoKbps: number; audioKbps: number; durationSec: number }

async function optimizeVideo(
  input: string,
  targetBytes: number,
  output: string,
  resolve: BinaryResolver,
  ctx: ConvertContext,
): Promise<VideoApplied> {
  const ffmpeg = await requireBinary(resolve, FFMPEG, ctx)
  const ffprobe = await requireBinary(resolve, FFPROBE, ctx)
  const probe = await probeMedia(ffprobe, input, ctx.timeoutMs, ctx.signal)
  const durationSec = Number.parseFloat(probe?.format?.duration ?? '')
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new OptimizeError(convertError('invalid_input', 'Cannot determine the video duration (ffprobe returned nothing usable).'))
  }

  // Container overhead + muxing slack: aim at 95% of the target.
  const totalKbits = (targetBytes * 0.95 * 8) / 1000
  let audioKbps = 128
  let videoKbps = Math.floor(totalKbits / durationSec) - audioKbps
  if (videoKbps < 50) {
    audioKbps = 64
    videoKbps = Math.floor(totalKbits / durationSec) - audioKbps
  }
  if (videoKbps < 30) {
    const minBytes = Math.ceil(((30 + 64) * 1000 * durationSec) / 8 + 512 * 1024)
    throw new OptimizeError(convertError('unsupported_conversion',
      `Target size is too small: this ${durationSec.toFixed(1)}s video needs at least about ${(minBytes / 1048576).toFixed(1)} MB.`,
      { hint: 'Increase target_size_mb, or shorten/trim the video first.' }))
  }

  const passlog = path.join(os.tmpdir(), `dsh-file-convert-pass-${Date.now()}`)
  // pass 2 writes to a scratch file; the output path only ever sees a
  // complete file, so an abort never leaves a broken mp4 behind.
  const scratch = path.join(os.tmpdir(), `dsh-file-convert-out-${Date.now()}.mp4`)
  try {
    try {
      await execTool(ffmpeg, [
        ...FFMPEG_GLOBAL, '-i', input,
        '-c:v', 'libx264', '-b:v', `${videoKbps}k`, '-pass', '1', '-passlogfile', passlog,
        '-an', '-f', 'null', '-',
      ], { timeoutMs: ctx.timeoutMs, signal: ctx.signal })
      await execTool(ffmpeg, [
        ...FFMPEG_GLOBAL, '-i', input,
        '-c:v', 'libx264', '-b:v', `${videoKbps}k`, '-pass', '2', '-passlogfile', passlog,
        '-c:a', 'aac', '-b:a', `${audioKbps}k`, '-movflags', '+faststart',
        scratch,
      ], { timeoutMs: ctx.timeoutMs, signal: ctx.signal })
      await fs.copyFile(scratch, output)
    } catch (err) {
      // Sources with broken DTS/timestamps (screen recordings, stitched clips)
      // can fail pass 2; point users at the normalize-then-optimize path.
      if (err instanceof ExecError && err.code === 'failed') {
        throw new OptimizeError(convertError('conversion_failed', 'Two-pass encoding failed.', {
          detail: err.stderr,
          hint: 'If the source has unusual timestamps, run convert_file to MP4 first and optimize that result.',
        }))
      }
      throw err
    }
  } finally {
    await fs.rm(scratch, { force: true }).catch(() => undefined)
    for (const suffix of ['-0.log', '-0.log.mbtree']) {
      await fs.rm(passlog + suffix, { force: true }).catch(() => undefined)
    }
  }
  return { videoKbps, audioKbps, durationSec }
}

/** Binary-search the highest encoder quality whose output fits the target. */
async function optimizeQuality(
  input: string,
  targetBytes: number,
  output: string,
  format: 'jpg' | 'webp' | 'png',
): Promise<number> {
  const encode = async (quality: number): Promise<Buffer> => {
    const pipeline = sharp(input)
    if (format === 'jpg') return pipeline.flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer()
    if (format === 'webp') return pipeline.webp({ quality }).toBuffer()
    return pipeline.png({ palette: true, quality, effort: 7 }).toBuffer()
  }

  const low = format === 'webp' ? 1 : format === 'png' ? 0 : 5
  const high = format === 'png' ? 100 : 95

  const floorBuffer = await encode(low)
  if (floorBuffer.length > targetBytes) {
    // Nothing fits: write the smallest variant and let the caller decide.
    await fs.writeFile(output, floorBuffer)
    return low
  }

  let bestQuality = low
  let bestBuffer = floorBuffer
  let lo = low
  let hi = high
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    const buffer = await encode(mid)
    if (buffer.length <= targetBytes) {
      bestQuality = mid
      bestBuffer = buffer
      lo = mid
    } else {
      hi = mid
    }
  }
  await fs.writeFile(output, bestBuffer)
  return bestQuality
}

/** Ghostscript presets, coarse to fine; keep the smallest produced result. */
const PDF_PRESETS = [
  { name: 'printer (300 dpi)', setting: '/printer' },
  { name: 'ebook (150 dpi)', setting: '/ebook' },
  { name: 'screen (72 dpi)', setting: '/screen' },
]

async function optimizePdf(
  input: string,
  targetBytes: number,
  output: string,
  resolve: BinaryResolver,
  ctx: ConvertContext,
): Promise<{ detail: string; warnings: string[] }> {
  const gs = await requireBinary(resolve, GHOSTSCRIPT, ctx)
  // Default SAFER mode applies: the command-line input file and the explicit
  // -sOutputFile are both inside its allowlist, so no -dNOSAFER is needed.
  const base = [
    '-dNOPAUSE', '-dBATCH', '-dQUIET',
    '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4',
  ]
  // Each preset writes to a scratch file; the final winner is copied to the
  // output path atomically, so an abort never leaves a half-written PDF.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-pdf-opt-'))
  try {
    let smallestSize = Number.POSITIVE_INFINITY
    let smallestFile = ''
    let smallestName = ''

    for (const [index, preset] of PDF_PRESETS.entries()) {
      if (ctx.signal?.aborted) {
        throw new OptimizeError(convertError('cancelled', 'Optimization cancelled.'))
      }
      const attempt = path.join(tmpDir, `attempt-${index}.pdf`)
      await execTool(gs, [...base, `-sOutputFile=${attempt}`, `-dPDFSETTINGS=${preset.setting}`, input], {
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
      })
      const size = (await fs.stat(attempt)).size
      if (size <= targetBytes) {
        await fs.copyFile(attempt, output)
        return { detail: `ghostscript ${preset.name}`, warnings: [] }
      }
      if (size < smallestSize) {
        smallestSize = size
        smallestFile = attempt
        smallestName = preset.name
      }
    }

    // The screen preset (smallest) is still above the target; keep it with
    // an honest warning.
    await fs.copyFile(smallestFile, output)
    return {
      detail: 'ghostscript screen (72 dpi)',
      warnings: [
        `Even the lowest preset exceeds the target (${Math.round(smallestSize / 1024)} KB produced); the smallest result was kept.`,
      ],
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function requireBinary(resolve: BinaryResolver, dep: BinaryDependency, ctx: ConvertContext): Promise<string> {
  const resolved = await resolve(dep)
  if (!resolved) {
    throw new OptimizeError(convertError('missing_dependency', `Missing dependency: ${dep.displayName ?? dep.name}.`, {
      missing: [dep],
      hint: `Install hint (${process.platform}): ${dep.installHint[platformKey()]}`,
    }))
  }
  void ctx
  return resolved
}

function platformKey(): 'win32' | 'darwin' | 'linux' {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
}
