import fs from 'node:fs/promises'
import sharp, { type Sharp } from 'sharp'
import { convertError } from '../errors.js'
import type {
  ConvertContext,
  ConvertRequest,
  ConvertResult,
  Converter,
  ConversionCapability,
  FormatId,
} from '../types.js'

const IMAGE_INPUTS: FormatId[] = ['png', 'jpg', 'webp', 'svg']
const IMAGE_OUTPUTS: FormatId[] = ['png', 'jpg', 'webp']

/**
 * All raster↔raster pairs plus SVG rasterization, backed by sharp/libvips
 * (prebuilt npm binaries - no system dependencies).
 */
export class ImageConverter implements Converter {
  readonly id = 'image'
  readonly concurrency = 4
  readonly binaryDeps = []

  readonly capabilities: ConversionCapability[] = IMAGE_INPUTS.flatMap((from) =>
    IMAGE_OUTPUTS.filter((to) => to !== from).map((to) => ({ from, to })),
  )

  async convert(req: ConvertRequest, ctx: ConvertContext): Promise<ConvertResult> {
    const started = Date.now()
    if (ctx.signal?.aborted) {
      return { ok: false, input: req.input, from: req.from, to: req.to, error: convertError('cancelled', 'Conversion cancelled.') }
    }
    try {
      const bytesIn = (await fs.stat(req.input)).size
      // density only affects vector input (SVG): 72 renders at the SVG's own
      // pixel size; a higher dpi option upscales. Rasters ignore it.
      const pipeline = sharp(req.input, { density: req.options.dpi ?? 72 })
      const { quality, background } = req.options

      let out: Sharp
      if (req.to === 'jpg') {
        out = pipeline
          .flatten({ background: background ?? '#ffffff' }) // jpg has no alpha channel
          .jpeg({ quality: quality ?? 85 })
      } else if (req.to === 'webp') {
        out = pipeline.webp({ quality: quality ?? 85 })
      } else {
        out = pipeline.png()
      }

      await out.toFile(req.output)
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
      return {
        ok: false,
        input: req.input,
        from: req.from,
        to: req.to,
        error: convertError('conversion_failed', `Failed to convert ${req.from} → ${req.to}`, {
          detail: err instanceof Error ? err.message : String(err),
        }),
      }
    }
  }
}
