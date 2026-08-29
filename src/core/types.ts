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
  | 'png'
  | 'jpg'
  | 'webp'
  | 'svg'
  | 'json'
  | 'yaml'
  | 'csv'
  | 'txt'

export type FormatCategory = 'document' | 'image' | 'data' | 'text'

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
 * An external binary the plugin shells out to. V0.1 converters use none of
 * these; the interface is fixed now so V0.2 (FFmpeg) / V0.3 (LibreOffice,
 * Poppler) slot in without changing the contract.
 */
export interface BinaryDependency {
  name: string
  /** Command names probed on PATH, e.g. ['ffmpeg']. */
  commands: string[]
  /** Plugin config key that overrides the resolved path, e.g. 'ffmpegPath'. */
  configKey?: string
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
  | { kind: 'data'; format: FormatId; records?: number; bytes: number }
  | { kind: 'unknown'; bytes: number; mime?: string }
