import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** Default JPEG/WebP quality (1-100). */
  quality: number
  /** Default rasterization DPI for pdf/svg inputs. */
  dpi: number
  /** Cooperative deadline for one conversion, in milliseconds. */
  timeoutMs: number
  /** Max files examined per batch_convert run before it stops and reports. */
  batchMaxFiles: number
  /**
   * When non-empty, explicit output paths must resolve inside one of these
   * directories. Empty (default) = unrestricted - fine on a personal machine;
   * set it when the harness is shared or exposed.
   */
  outputRoots: string[]
  /** Explicit path to the ffmpeg binary (Windows installs without PATH). */
  ffmpegPath?: string
  /** Explicit path to the ffprobe binary (usually next to ffmpeg). */
  ffprobePath?: string
  /** Explicit path to the LibreOffice soffice binary. */
  sofficePath?: string
  /** Explicit path to the Ghostscript binary (gswin64c on Windows). */
  ghostscriptPath?: string
  /** Explicit python interpreter for the pdf2docx-based PDF → DOCX conversion. */
  pythonPath?: string
}

export const Config: Schema<Config> = Schema.object({
  quality: Schema.number().min(1).max(100).default(85).description('Default JPEG/WebP quality (1-100).'),
  dpi: Schema.number().min(72).max(600).default(150).description('Default rasterization DPI for PDF/SVG inputs.'),
  timeoutMs: Schema.number().min(1000).default(120_000).description('Cooperative timeout for one conversion (ms). For long video jobs consider 600000.'),
  batchMaxFiles: Schema.number().min(1).default(500).description('Max files examined per batch_convert run; extra files are reported, not silently skipped.'),
  outputRoots: Schema.array(Schema.string()).default([]).description('Restrict explicit output paths to these directories. Empty = unrestricted.'),
  ffmpegPath: Schema.string().description('Explicit ffmpeg binary path (overrides PATH lookup).'),
  ffprobePath: Schema.string().description('Explicit ffprobe binary path (overrides PATH lookup).'),
  sofficePath: Schema.string().description('Explicit LibreOffice soffice binary path (overrides auto-detection).'),
  ghostscriptPath: Schema.string().description('Explicit Ghostscript binary path (overrides PATH lookup).'),
  pythonPath: Schema.string().description('Explicit python interpreter for the pdf2docx-based PDF → DOCX conversion.'),
})
