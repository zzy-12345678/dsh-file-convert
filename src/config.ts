import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** Default JPEG/WebP quality (1-100). */
  quality: number
  /** Default rasterization DPI for pdf/svg inputs. */
  dpi: number
  /** Cooperative deadline for one conversion, in milliseconds. */
  timeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  quality: Schema.number().min(1).max(100).default(85).description('Default JPEG/WebP quality (1-100).'),
  dpi: Schema.number().min(72).max(600).default(150).description('Default rasterization DPI for PDF/SVG inputs.'),
  timeoutMs: Schema.number().min(1000).default(120_000).description('Cooperative timeout for one conversion (ms).'),
})
