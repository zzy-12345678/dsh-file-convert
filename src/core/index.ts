/**
 * dsh-file-convert core: a DSH-independent conversion library.
 * Usable directly from tests, a CLI, or an MCP server - no harness required.
 */
export * from './types.js'
export { FORMATS, FORMAT_IDS, formatFromExtension, parseFormatArg, canonicalExtension, formatCategory } from './formats.js'
export { ConversionRouter, type RouterDefaults, type ConvertFileRequest, type ConvertRunContext } from './router.js'
export { detectFile, DetectError, type DetectOutcome } from './detect.js'
export { defaultOutputPath, batchOutputPath } from './paths.js'
export { ImageConverter } from './converters/image.js'
export { PdfConverter } from './converters/pdf.js'
export { DataConverter } from './converters/data.js'

import { ConversionRouter, type RouterDefaults } from './router.js'
import { ImageConverter } from './converters/image.js'
import { PdfConverter } from './converters/pdf.js'
import { DataConverter } from './converters/data.js'

/** Assemble the V0.1 registry: image (sharp), pdf (pdfjs), data (yaml/csv). */
export function createRouter(defaults?: Partial<RouterDefaults>): ConversionRouter {
  const router = new ConversionRouter({
    quality: defaults?.quality ?? 85,
    dpi: defaults?.dpi ?? 150,
    timeoutMs: defaults?.timeoutMs ?? 120_000,
  })
  router.register(new ImageConverter())
  router.register(new PdfConverter())
  router.register(new DataConverter())
  return router
}
