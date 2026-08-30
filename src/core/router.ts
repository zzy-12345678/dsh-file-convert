import fs from 'node:fs/promises'
import path from 'node:path'
import { convertError, toConvertError } from './errors.js'
import { formatCategory, FORMAT_IDS, parseFormatArg } from './formats.js'
import { detectFile, DetectError, type DetectOutcome } from './detect.js'
import { inspectFile } from './inspect.js'
import { defaultOutputPath } from './paths.js'
import { isInsideAnyRoot, isSameFile } from './utils/path-guard.js'
import { resolveBinary } from './binary.js'
import { FFPROBE } from './converters/media.js'
import type {
  ConvertContext,
  ConvertOptions,
  ConvertRequest,
  ConvertResult,
  Converter,
  ConversionStatus,
  Detection,
  FormatId,
  InspectResult,
  Logger,
} from './types.js'

export interface RouterDefaults {
  /** Default JPEG/WebP quality (1-100). */
  quality: number
  /** Default rasterization DPI for pdf/svg inputs. */
  dpi: number
  /** Cooperative deadline for one conversion, in milliseconds. */
  timeoutMs: number
  /**
   * When non-empty, EXPLICIT output paths must resolve inside one of these
   * directories (case-insensitive on Windows). Default output (next to the
   * input) is exempt. Empty = unrestricted, which is fine for a personal
   * single-user harness; set it for shared deployments.
   */
  outputRoots?: string[]
  /** Config-key overrides for external binary resolution, e.g. ffmpegPath. */
  binaryOverrides?: Record<string, string>
  /** Inputs larger than this are refused (bytes). Default 2 GiB. */
  maxInputBytes?: number
  /** Full-document PDF rasterization refuses to exceed this page count. Default 200. */
  maxPdfPages?: number
  /** Rasterized pixels per page are clamped to this. Default 16 MP. */
  maxOutputPixels?: number
}

export interface ConvertFileRequest {
  input: string
  /** Free-text target format; aliases like 'jpeg' / '.yml' are accepted. */
  outputFormat: string
  /** Absolute output path; defaults to next to the input file. */
  output?: string
  overwrite?: boolean
  quality?: number
  dpi?: number
  /** One-based inclusive page selection for PDF inputs, e.g. '1-3,5'. */
  pages?: string
  /** OCR the pages instead of reading the text layer (PDF → TXT). */
  ocr?: boolean
  /** OCR languages, '+'-separated. Default 'chi_sim+eng'. */
  ocrLang?: string
}

export interface ConvertRunContext {
  logger: Logger
  signal?: AbortSignal
}

const DEFAULTS: RouterDefaults = { quality: 85, dpi: 150, timeoutMs: 120_000 }

/**
 * The facade every tool talks to. Owns the capability registry, detection,
 * dependency checks, overwrite policy, and error normalization — converters
 * only see well-formed requests.
 */
export class ConversionRouter {
  private readonly converters = new Map<string, Converter>()
  private readonly byPair = new Map<FormatId, Map<FormatId, Converter>>()

  constructor(private readonly defaults: RouterDefaults = DEFAULTS) {}

  register(converter: Converter): void {
    if (this.converters.has(converter.id)) {
      throw new Error(`Converter id already registered: ${converter.id}`)
    }
    this.converters.set(converter.id, converter)
    for (const cap of converter.capabilities) {
      let targets = this.byPair.get(cap.from)
      if (!targets) this.byPair.set(cap.from, (targets = new Map()))
      if (targets.has(cap.to)) {
        throw new Error(`Duplicate capability ${cap.from} -> ${cap.to} (${converter.id})`)
      }
      targets.set(cap.to, converter)
    }
  }

  detect(input: string): Promise<DetectOutcome> {
    return detectFile(input)
  }

  route(from: FormatId, to: FormatId): Converter | null {
    return this.byPair.get(from)?.get(to) ?? null
  }

  /** The full matrix with dependency availability, for list_conversions. */
  async listConversions(): Promise<ConversionStatus[]> {
    const statuses: ConversionStatus[] = []
    for (const converter of this.converters.values()) {
      for (const cap of converter.capabilities) {
        const missing: string[] = []
        for (const dep of converter.binaryDeps) {
          if (!(await resolveBinary(dep, this.defaults.binaryOverrides ?? {}, NULL_LOGGER))) missing.push(dep.name)
        }
        for (const name of cap.extraDeps ?? []) missing.push(name)
        statuses.push({
          from: cap.from,
          to: cap.to,
          available: missing.length === 0,
          experimental: cap.experimental ?? false,
          missing,
        })
      }
    }
    statuses.sort(
      (a, b) =>
        (CATEGORY_RANK.get(a.from) ?? 0) - (CATEGORY_RANK.get(b.from) ?? 0) ||
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to),
    )
    return statuses
  }

  /** Full pipeline: detect → route → deps → overwrite policy → convert. */
  async convertFile(req: ConvertFileRequest, run: ConvertRunContext): Promise<ConvertResult> {
    const to = parseFormatArg(req.outputFormat)
    if (!to) {
      const failure = convertError(
        'unsupported_conversion',
        `Unknown output format '${req.outputFormat}'.`,
        { hint: `Supported formats: ${FORMAT_IDS.join(', ')}.` },
      )
      return { ok: false, input: req.input, error: failure }
    }

    try {
      const inputStat = await fs.stat(req.input).catch(() => null)
      if (inputStat?.isDirectory()) {
        return {
          ok: false, input: req.input, to,
          error: convertError('invalid_input', `Input is a directory, not a file: ${req.input}`),
        }
      }
      const maxInputBytes = this.defaults.maxInputBytes ?? 2 * 1024 ** 3
      if (inputStat && inputStat.size > maxInputBytes) {
        const formatMb = (n: number) => `${Math.round(n / 1048576).toLocaleString('en-US')} MB`
        return {
          ok: false, input: req.input, to,
          error: convertError('invalid_input', `Input is ${formatMb(inputStat.size)}, above the ${formatMb(maxInputBytes)} limit.`, {
            hint: "Raise 'maxInputMb' in the plugin config, or convert in parts.",
          }),
        }
      }

      const { detection, warnings } = await detectFile(req.input)
      const from = detection.format

      if (from === to) {
        return {
          ok: false, input: req.input, from, to,
          error: convertError('unsupported_conversion', `Input is already ${to}.`),
        }
      }
      const converter = this.route(from, to)
      if (!converter) {
        return {
          ok: false, input: req.input, from, to,
          error: convertError('unsupported_conversion', `No conversion from ${from} to ${to}.`, {
            hint: 'Run list_conversions to see the supported matrix.',
          }),
        }
      }

      const missing = await missingDeps(converter, this.defaults.binaryOverrides ?? {})
      if (missing.length > 0) {
        return {
          ok: false, input: req.input, from, to,
          error: convertError('missing_dependency', `Missing external dependency: ${missing.map((m) => m.name).join(', ')}.`, {
            missing,
            hint: `Install hint (${process.platform}): ${
              missing.map((m) => platformHint(m.installHint)).join('; ')
            }`,
          }),
        }
      }

      const output = req.output ?? defaultOutputPath(req.input, to)
      if (await isSameFile(output, req.input)) {
        return {
          ok: false, input: req.input, from, to,
          error: convertError('invalid_input', 'Output path equals the input path; converting would destroy the source.', {
            hint: 'Choose a different output name or omit output to write next to the input with the new extension.',
          }),
        }
      }
      if (req.output !== undefined && !(await isInsideAnyRoot(output, this.defaults.outputRoots))) {
        return {
          ok: false, input: req.input, from, to,
          error: convertError('invalid_input', `Output path ${output} is outside every configured outputRoot.`, {
            hint: `Allowed roots: ${this.defaults.outputRoots?.join(', ')}. Omit output to write next to the input.`,
          }),
        }
      }
      await fs.mkdir(path.dirname(output), { recursive: true })
      const overwrite = req.overwrite ?? false
      if (!overwrite && (await exists(output))) {
        return {
          ok: false, input: req.input, from, to,
          error: convertError('output_exists', `Output file already exists: ${output}`, {
            hint: 'Pass overwrite: true to replace it.',
          }),
        }
      }

      const options: ConvertOptions = {
        overwrite,
        // quality has one shared default; dpi semantics differ per backend
        // (PDF rasterization vs SVG density), so converters apply their own.
        quality: req.quality ?? this.defaults.quality,
        dpi: req.dpi,
        pages: req.pages,
        ocr: req.ocr,
        ocrLang: req.ocrLang,
      }
      const request: ConvertRequest = { input: req.input, output, from, to, options }

      // True cancellation: the timeout (or the caller) aborts an internal
      // controller that converters actually observe, so work stops instead of
      // being abandoned behind an already-returned promise.
      const controller = new AbortController()
      const onCallerAbort = () => controller.abort()
      run.signal?.addEventListener('abort', onCallerAbort, { once: true })
      const ctx: ConvertContext = {
        logger: run.logger,
        signal: AbortSignal.any([controller.signal, ...(run.signal ? [run.signal] : [])]),
        timeoutMs: this.defaults.timeoutMs,
        limits: { maxPdfPages: this.defaults.maxPdfPages, maxOutputPixels: this.defaults.maxOutputPixels },
      }

      let timer: NodeJS.Timeout | undefined
      try {
        const timeoutPromise = new Promise<ConvertResult>((resolve) => {
          timer = setTimeout(() => {
            controller.abort()
            resolve({
              ok: false,
              input: req.input,
              from,
              to,
              error: convertError('timeout', `Conversion exceeded ${Math.round(ctx.timeoutMs / 1000)}s and was cancelled.`),
            })
          }, ctx.timeoutMs)
        })
        const result = await Promise.race([converter.convert(request, ctx), timeoutPromise])
        if (result.ok) result.warnings.unshift(...warnings)
        return result
      } finally {
        clearTimeout(timer as NodeJS.Timeout | undefined)
        run.signal?.removeEventListener('abort', onCallerAbort)
      }
    } catch (err) {
      if (err instanceof DetectError) {
        return { ok: false, input: req.input, to, error: err.error }
      }
      return {
        ok: false,
        input: req.input,
        to,
        error: toConvertError(err, `Conversion failed for ${req.input}`),
      }
    }
  }

  async inspect(input: string): Promise<InspectResult> {
    const inputStat = await fs.stat(input).catch(() => null)
    if (inputStat?.isDirectory()) {
      throw new DetectError(convertError('invalid_input', `Input is a directory, not a file: ${input}`))
    }
    const maxInputBytes = this.defaults.maxInputBytes ?? 2 * 1024 ** 3
    if (inputStat && inputStat.size > maxInputBytes) {
      throw new DetectError(
        convertError('invalid_input', `Input is ${Math.round(inputStat.size / 1048576).toLocaleString('en-US')} MB, above the ${Math.round(maxInputBytes / 1048576).toLocaleString('en-US')} MB limit for inspection.`, {
          hint: "Raise 'maxInputMb' in the plugin config.",
        }),
      )
    }
    const { detection } = await detectFile(input)
    const bytes = (await fs.stat(input)).size
    let media: Parameters<typeof inspectFile>[3]
    if (detection.format === 'mp4' || detection.format === 'mov' || detection.format === 'mp3' || detection.format === 'wav') {
      const ffprobe = await resolveBinary(FFPROBE, this.defaults.binaryOverrides ?? {}, NULL_LOGGER)
      if (ffprobe) {
        media = { ffprobePath: ffprobe, timeoutMs: Math.min(this.defaults.timeoutMs, 30_000) }
      }
    }
    return inspectFile(input, detection, bytes, media)
  }
}

/** Category ordering is static; compute the rank once instead of per sort call. */
const CATEGORY_RANK = new Map<FormatId, number>(
  [...FORMAT_IDS]
    .sort((a, b) => formatCategory(a).localeCompare(formatCategory(b)))
    .map((format, index) => [format, index]),
)

async function missingDeps(converter: Converter, overrides: Record<string, string>) {
  const missing: import('./types.js').BinaryDependency[] = []
  for (const dep of converter.binaryDeps) {
    if (!(await resolveBinary(dep, overrides, NULL_LOGGER))) missing.push(dep)
  }
  return missing
}

function platformHint(hint: { win32: string; darwin: string; linux: string }): string {
  return process.platform === 'win32' ? hint.win32 : process.platform === 'darwin' ? hint.darwin : hint.linux
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

const NULL_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} }
