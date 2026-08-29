import fs from 'node:fs/promises'
import path from 'node:path'
import { convertError, toConvertError } from './errors.js'
import { formatCategory, FORMAT_IDS, parseFormatArg } from './formats.js'
import { detectFile, DetectError, type DetectOutcome } from './detect.js'
import { inspectFile } from './inspect.js'
import { defaultOutputPath } from './paths.js'
import { resolveBinary } from './binary.js'
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
          if (!(await resolveBinary(dep, {}, NULL_LOGGER))) missing.push(dep.name)
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
        categoryRank(a.from) - categoryRank(b.from) ||
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

      const missing = await missingDeps(converter)
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
      }
      const request: ConvertRequest = { input: req.input, output, from, to, options }
      const ctx: ConvertContext = {
        logger: run.logger,
        signal: run.signal,
        timeoutMs: this.defaults.timeoutMs,
      }

      const result = await withTimeout(converter.convert(request, ctx), ctx.timeoutMs, {
        input: req.input, from, to,
      })
      if (result.ok) result.warnings.unshift(...warnings)
      return result
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
    const { detection } = await detectFile(input)
    const bytes = (await fs.stat(input)).size
    return inspectFile(input, detection, bytes)
  }
}

function categoryRank(format: FormatId): number {
  const order: FormatId[] = [...FORMAT_IDS].sort((a, b) => formatCategory(a).localeCompare(formatCategory(b)))
  return order.indexOf(format)
}

async function missingDeps(converter: Converter) {
  const missing: import('./types.js').BinaryDependency[] = []
  for (const dep of converter.binaryDeps) {
    if (!(await resolveBinary(dep, {}, NULL_LOGGER))) missing.push(dep)
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

/** Cooperative deadline: long-running converters also observe ctx.signal. */
async function withTimeout(
  promise: Promise<ConvertResult>,
  timeoutMs: number,
  meta: { input: string; from: FormatId; to: FormatId },
): Promise<ConvertResult> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<ConvertResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        input: meta.input,
        from: meta.from,
        to: meta.to,
        error: convertError('timeout', `Conversion exceeded ${Math.round(timeoutMs / 1000)}s and was abandoned.`),
      })
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

const NULL_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} }
