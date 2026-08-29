import fs from 'node:fs/promises'
import { ExecError, execTool } from '../utils/exec.js'
import { convertError } from '../errors.js'
import type {
  BinaryDependency,
  ConvertContext,
  ConvertRequest,
  ConvertResult,
  Converter,
  ConversionCapability,
} from '../types.js'

export const FFMPEG: BinaryDependency = {
  name: 'ffmpeg',
  commands: ['ffmpeg'],
  configKey: 'ffmpegPath',
  installHint: {
    win32: 'winget install Gyan.FFmpeg (or scoop install ffmpeg)',
    darwin: 'brew install ffmpeg',
    linux: 'sudo apt install ffmpeg',
  },
}

export const FFPROBE: BinaryDependency = {
  name: 'ffprobe',
  commands: ['ffprobe'],
  configKey: 'ffprobePath',
  installHint: FFMPEG.installHint, // always ships together
}

/** Options that ffmpeg must never prompt or decorate about. */
const GLOBAL = ['-hide_banner', '-nostdin', '-y']

/**
 * Audio/video conversions, delegated to a locally installed FFmpeg.
 * The converter declares its dependencies; the router refuses to run (and
 * list_conversions reports what is missing) until the binaries resolve.
 */
export class MediaConverter implements Converter {
  readonly id = 'media'
  readonly concurrency = 2
  readonly binaryDeps = [FFMPEG, FFPROBE]

  readonly capabilities: ConversionCapability[] = [
    { from: 'mp4', to: 'gif' },
    { from: 'mp4', to: 'mp3' },
    { from: 'mov', to: 'mp4' },
    { from: 'wav', to: 'mp3' },
  ]

  constructor(
    private readonly resolve: (dep: BinaryDependency) => Promise<string | null>,
  ) {}

  async convert(req: ConvertRequest, ctx: ConvertContext): Promise<ConvertResult> {
    const started = Date.now()
    try {
      const bytesIn = (await fs.stat(req.input)).size
      const ffmpeg = await this.required(FFMPEG)
      switch (`${req.from}->${req.to}`) {
        case 'mp4->gif':
          await execTool(ffmpeg, gifArgs(req), this.execOpts(ctx))
          break
        case 'mp4->mp3':
        case 'wav->mp3':
          await execTool(ffmpeg, audioArgs(req), this.execOpts(ctx))
          break
        case 'mov->mp4':
          await this.movToMp4(req, ctx, ffmpeg)
          break
        default:
          return fail(req, convertError('unsupported_conversion', `MediaConverter cannot handle ${req.from} -> ${req.to}.`))
      }
      const bytesOut = (await fs.stat(req.output)).size
      return {
        ok: true,
        input: req.input,
        output: req.output,
        from: req.from,
        to: req.to,
        bytesIn,
        bytesOut,
        durationMs: Date.now() - started,
        warnings: [],
      }
    } catch (err) {
      if (err instanceof BinaryMissingError) {
        return fail(req, convertError('missing_dependency', `Missing dependency: ${err.dep.name}.`, {
          missing: [err.dep],
          hint: `Install hint (${process.platform}): ${err.dep.installHint[platformKey()]}`,
        }))
      }
      if (err instanceof ExecError) {
        const code = err.code === 'timeout' ? 'timeout' : err.code === 'cancelled' ? 'cancelled' : 'conversion_failed'
        return fail(req, convertError(code, `Failed to convert ${req.from} → ${req.to} (ffmpeg).`, { detail: err.stderr }))
      }
      return fail(req, convertError('conversion_failed', `Failed to convert ${req.from} → ${req.to}`, {
        detail: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  /** MOV→MP4: try a lossless container swap first, fall back to re-encoding. */
  private async movToMp4(req: ConvertRequest, ctx: ConvertContext, ffmpeg: string): Promise<void> {
    try {
      await execTool(ffmpeg, [...GLOBAL, '-i', req.input, '-c', 'copy', '-movflags', '+faststart', req.output], this.execOpts(ctx))
    } catch {
      await execTool(
        ffmpeg,
        [...GLOBAL, '-i', req.input, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', req.output],
        this.execOpts(ctx),
      )
    }
  }

  private async required(dep: BinaryDependency): Promise<string> {
    const resolved = await this.resolve(dep)
    if (!resolved) {
      throw new BinaryMissingError(dep)
    }
    return resolved
  }

  private execOpts(ctx: ConvertContext) {
    return { timeoutMs: ctx.timeoutMs, signal: ctx.signal }
  }
}

class BinaryMissingError extends Error {
  constructor(readonly dep: BinaryDependency) {
    super(`Missing dependency: ${dep.name}`)
  }
}

function platformKey(): 'win32' | 'darwin' | 'linux' {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
}

function gifArgs(req: ConvertRequest): string[] {
  // Two-pass palette in one filter graph: split -> palettegen + paletteuse.
  return [
    ...GLOBAL,
    '-i', req.input,
    '-filter_complex', '[0:v] fps=12,scale=480:-2:flags=lanczos,split [a][b];[a] palettegen [p];[b][p] paletteuse',
    req.output,
  ]
}

function audioArgs(req: ConvertRequest): string[] {
  const quality = req.options.quality ?? 85
  const kbps = Math.round(64 + (Math.min(100, Math.max(1, quality)) / 100) * (320 - 64))
  return [...GLOBAL, '-i', req.input, '-vn', '-codec:a', 'libmp3lame', '-b:a', `${kbps}k`, req.output]
}

function fail(req: ConvertRequest, error: import('../types.js').ConvertError): ConvertResult {
  return { ok: false, input: req.input, from: req.from, to: req.to, error }
}
