/**
 * Core type definitions for dsh-file-convert.
 *
 * This module (and everything under src/core) is deliberately independent of
 * DeepSeek Harness / Cordis so it can be tested and reused without a running
 * harness. The DSH glue layer lives in src/index.ts and src/tools/.
 */

// ─── Formats ────────────────────────────────────────────────────────────────

export type FormatId =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'png'
  | 'jpg'
  | 'webp'
  | 'svg'
  | 'gif'
  | 'mp4'
  | 'mov'
  | 'mp3'
  | 'wav'
  | 'json'
  | 'yaml'
  | 'csv'
  | 'txt'

export type FormatCategory = 'document' | 'image' | 'video' | 'audio' | 'data' | 'text'

export interface FormatMeta {
  category: FormatCategory
  /** Canonical extension first; used for default output naming. */
  extensions: string[]
  mime: string
}

// ─── Capability declarations ────────────────────────────────────────────────

/** One declarative row of the conversion matrix. */
export interface ConversionCapability {
  from: FormatId
  to: FormatId
  /** Binaries needed by this specific row beyond the converter-level deps. */
  extraDeps?: string[]
  experimental?: boolean
}

/**
 * An external binary the plugin shells out to.
 * Resolution order: config override → PATH → known install locations →
 * plugin cache. `probe` allows deep checks (python with a specific module
 * installed), `extraPaths` covers Windows installs that are not on PATH.
 */
export interface BinaryDependency {
  name: string
  /** Name shown to users when this dependency is missing. */
  displayName?: string
  /** Command names probed on PATH, e.g. ['ffmpeg']. */
  commands: string[]
  /** Plugin config key that overrides the resolved path, e.g. 'ffmpegPath'. */
  configKey?: string
  /** Absolute locations probed when the command is not on PATH. */
  extraPaths?: { win32?: string[]; darwin?: string[]; linux?: string[] }
  /**
   * Deep check run against the resolved path; false counts as missing
   * (e.g. python present but the required package not importable).
   * Results are memoized per (dependency, path) for the process lifetime.
   */
  probe?: (resolvedPath: string) => Promise<boolean>
  installHint: { win32: string; darwin: string; linux: string }
}

// ─── Conversion request / result ────────────────────────────────────────────

export interface ConvertOptions {
  overwrite: boolean
  /** 1-100, lossy targets (jpg/webp) only. */
  quality?: number
  /** CSS color used to flatten alpha for non-alpha targets. Default '#ffffff'. */
  background?: string
  /** Rasterization density for vector inputs (pdf/svg), in DPI. */
  dpi?: number
  /** Indentation for json/yaml output. Default 2. */
  indent?: number
  /** CSV delimiter. Default: sniffed from the first lines (, ; \t). */
  delimiter?: string
  /** One-based inclusive page selection for PDF inputs, e.g. '1-3,5,8-10'. */
  pages?: string
  /** OCR pages instead of reading the text layer (PDF → TXT). */
  ocr?: boolean
  /** OCR languages, '+'-separated. Default 'chi_sim+eng'. */
  ocrLang?: string
  /** Escape hatch for backend-specific options. */
  extra?: Record<string, unknown>
}

export interface ConvertRequest {
  /** Absolute path to an existing file. */
  input: string
  /** Absolute output path, already resolved by the caller. */
  output: string
  from: FormatId
  to: FormatId
  options: ConvertOptions
}

export type ConvertErrorCode =
  | 'input_not_found'
  | 'unknown_format'
  | 'unsupported_conversion'
  | 'missing_dependency'
  | 'invalid_input'
  | 'output_exists'
  | 'conversion_failed'
  | 'timeout'
  | 'cancelled'

export interface ConvertError {
  code: ConvertErrorCode
  /** One human-readable line; agents relay this to the user verbatim. */
  message: string
  /** Truncated stderr / decoder output for debugging. */
  detail?: string
  missing?: BinaryDependency[]
  hint?: string
}

export type ConvertResult =
  | {
      ok: true
      input: string
      output: string
      from: FormatId
      to: FormatId
      bytesIn: number
      bytesOut: number
      durationMs: number
      warnings: string[]
      /**
       * Present when one input produced several outputs (multi-page PDF
       * rasterization). Always includes `output` as the first entry.
       */
      outputs?: string[]
    }
  | {
      ok: false
      input: string
      /** Absent when the input format could not be detected. */
      from?: FormatId
      /** Absent when the requested output format was not parseable. */
      to?: FormatId
      error: ConvertError
    }

export interface Logger {
  debug(msg: string): void
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export interface ConvertContext {
  logger: Logger
  signal?: AbortSignal
  /** Hard deadline for a single conversion, in milliseconds. */
  timeoutMs: number
  /** Resource ceilings applied to rasterization and page loops. */
  limits?: {
    /** Full-document PDF rasterization refuses to exceed this page count. */
    maxPdfPages?: number
    /** Rasterized pixels per page (width × height) are clamped to this. */
    maxOutputPixels?: number
  }
}

// ─── Converter contract ─────────────────────────────────────────────────────

export interface Converter {
  id: string
  capabilities: ConversionCapability[]
  binaryDeps: BinaryDependency[]
  /** Max parallel conversions for batch pools. 1 = must serialize. */
  concurrency: number
  convert(req: ConvertRequest, ctx: ConvertContext): Promise<ConvertResult>
}

// ─── Detection / listing / inspection ───────────────────────────────────────

export interface Detection {
  format: FormatId
  /**
   * 'magic' = decided by file content (binary magic, SVG/JSON sniffing);
   * 'guess' = weak content heuristic (YAML document marker);
   * 'extension' = decided by file name.
   */
  confidence: 'magic' | 'extension' | 'guess'
  mime?: string
}

export interface ConversionStatus {
  from: FormatId
  to: FormatId
  available: boolean
  experimental: boolean
  /** Names of missing external binaries; empty when available. */
  missing: string[]
}

export type InspectResult =
  | {
      kind: 'image'
      format: FormatId
      width: number
      height: number
      channels?: number
      bytes: number
    }
  | {
      kind: 'pdf'
      pages: number
      encrypted: boolean
      /** Heuristic: almost no extractable text → likely a scanned PDF. */
      likelyScanned: boolean
      bytes: number
    }
  | {
      kind: 'media'
      format: FormatId
      durationSec?: number
      width?: number
      height?: number
      fps?: number
      audioCodec?: string
      /** Present when ffprobe is missing; inspect degrades instead of failing. */
      probeUnavailable?: boolean
      bytes: number
    }
  | { kind: 'data'; format: FormatId; records?: number; bytes: number }
  | { kind: 'unknown'; bytes: number; mime?: string }
