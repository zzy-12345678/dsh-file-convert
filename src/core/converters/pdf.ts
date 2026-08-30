import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import './pdf-env.js'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { convertError } from '../errors.js'
import { PageRangeError, parsePageRange } from '../utils/pages.js'
import { writeFileAtomic } from '../utils/write-file.js'
import { OcrLanguageMissingError, OCR_LANGUAGE_DATA, TESSERACT, ocrLanguagesCached, resolveOcrEngine } from '../ocr.js'
import type {
  BinaryDependency,
  ConvertContext,
  ConvertRequest,
  ConvertResult,
  Converter,
  ConversionCapability,
} from '../types.js'

const require = createRequire(import.meta.url)

/**
 * Locate pdfjs-dist's standard_fonts directory so PDFs using the base-14
 * (and similar) fonts render with correct glyphs. Best effort: rendering
 * still works without it, some glyph substitutions may occur.
 */
function standardFontDataUrl(): string | undefined {
  for (const target of ['pdfjs-dist/package.json', 'pdfjs-dist/build/pdf.mjs', 'pdfjs-dist']) {
    let resolved: string
    try {
      resolved = require.resolve(target)
    } catch {
      continue
    }
    let dir = path.dirname(resolved)
    for (let i = 0; i < 5; i++) {
      try {
        const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
        if (pkg?.name === 'pdfjs-dist') {
          return pathToFileURL(path.join(dir, 'standard_fonts')).href + '/'
        }
      } catch {
        /* keep walking up */
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

/** Structural view of the pdfjs APIs we use, so the converter stays decoupled. */
interface PdfPageLike {
  getViewport(args: { scale: number }): { width: number; height: number }
  render(args: { canvasContext: unknown; viewport: unknown }): { promise: Promise<void> }
  getTextContent(): Promise<{ items: unknown[] }>
  cleanup(): void
}

interface PdfDocumentLike {
  numPages: number
  getPage(n: number): Promise<PdfPageLike>
  cleanup(): Promise<void>
}

type TextItemLike = { str?: string; hasEOL?: boolean }

/**
 * PDF conversions, fully local: rasterization via pdfjs-dist + @napi-rs/canvas
 * (prebuilt npm binaries), text extraction via pdfjs-dist. No Poppler needed.
 */
export class PdfConverter implements Converter {
  readonly id = 'pdf'
  readonly concurrency = 2
  readonly binaryDeps = []

  readonly capabilities: ConversionCapability[] = [
    { from: 'pdf', to: 'png' },
    { from: 'pdf', to: 'jpg' },
    { from: 'pdf', to: 'txt' },
  ]

  /** Optional binary resolver, needed only for OCR (Tesseract). */
  constructor(private readonly resolve?: (dep: BinaryDependency) => Promise<string | null>) {}

  async convert(req: ConvertRequest, ctx: ConvertContext): Promise<ConvertResult> {
    const started = Date.now()
    try {
      const bytesIn = (await fs.stat(req.input)).size
      const data = new Uint8Array(await fs.readFile(req.input))
      const doc = (await getDocument({
        data,
        standardFontDataUrl: standardFontDataUrl(),
        verbosity: 0,
      }).promise) as unknown as PdfDocumentLike
      try {
        return req.to === 'txt'
          ? await this.toText(doc, req, ctx, bytesIn, started)
          : await this.toImages(doc, req, ctx, bytesIn, started)
      } finally {
        await doc.cleanup().catch(() => undefined)
      }
    } catch (err) {
      if (err instanceof PageRangeError) {
        return { ok: false, input: req.input, from: req.from, to: req.to, error: err.error }
      }
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

  /**
   * Multi-page PDFs produce `<base>-<n>.<ext>` files named after the REAL page
   * number; converting a single page (or a one-page PDF) writes exactly `output`.
   */
  private async toImages(
    doc: PdfDocumentLike,
    req: ConvertRequest,
    ctx: ConvertContext,
    bytesIn: number,
    started: number,
  ): Promise<ConvertResult> {
    const totalPages = doc.numPages
    const explicitSelection = Boolean(req.options.pages)
    const selected = req.options.pages ? parsePageRange(req.options.pages, totalPages) : pageRange(totalPages)
    const maxPdfPages = ctx.limits?.maxPdfPages
    if (!explicitSelection && maxPdfPages && totalPages > maxPdfPages) {
      return failErr(req, convertError('invalid_input', `PDF has ${totalPages} pages, above the ${maxPdfPages}-page rasterization limit.`, {
        hint: `Use pages (e.g. '1-${maxPdfPages}') to select, or raise 'maxPdfPages' in the plugin config.`,
      }))
    }
    if (explicitSelection && maxPdfPages && selected.length > maxPdfPages) {
      return failErr(req, convertError('invalid_input', `${selected.length} pages selected, above the ${maxPdfPages}-page rasterization limit.`, {
        hint: `Narrow the pages selection or raise 'maxPdfPages' in the plugin config.`,
      }))
    }
    const scale = (req.options.dpi ?? 150) / 72 // PDFs have no intrinsic pixel size; 150 is a sane default.
    const maxOutputPixels = ctx.limits?.maxOutputPixels
    let scaleReduced = false
    const pad = String(totalPages).length
    const outputs: string[] = []
    const warnings: string[] = []
    let bytesOut = 0

    for (const n of selected) {
      if (ctx.signal?.aborted) {
        return fail(req, 'cancelled', 'Conversion cancelled.')
      }
      const page = await doc.getPage(n)
      try {
        let renderScale = scale
        if (maxOutputPixels) {
          const viewport = page.getViewport({ scale })
          const pixels = viewport.width * viewport.height
          if (pixels > maxOutputPixels) {
            renderScale = scale * Math.sqrt(maxOutputPixels / pixels)
            // ceil() on the viewport dims can nudge us just over the budget
            const cw = Math.ceil(viewport.width * (renderScale / scale))
            const ch = Math.ceil(viewport.height * (renderScale / scale))
            if (cw * ch > maxOutputPixels) renderScale *= maxOutputPixels / (cw * ch)
            scaleReduced = true
          }
        }
        const buffer = await renderPage(page, renderScale, {
          background: req.to === 'jpg' ? req.options.background ?? '#ffffff' : undefined,
          quality: req.options.quality ?? 85,
          to: req.to as 'png' | 'jpg',
        })
        const out = selected.length === 1 ? req.output : withPageNumber(req.output, n, pad)
        await writeFileAtomic(out, buffer)
        bytesOut += buffer.byteLength
        outputs.push(out)
      } catch (err) {
        // all-or-nothing: a failed page removes the pages already written
        for (const written of outputs) await fs.rm(written, { force: true }).catch(() => undefined)
        throw err
      } finally {
        page.cleanup()
      }
    }

    if (selected.length < totalPages) {
      warnings.push(`Converted page(s) ${selected.join(', ')} of ${totalPages} (pages option).`)
    } else if (totalPages > 1) {
      warnings.push(`PDF has ${totalPages} pages; wrote ${totalPages} files named <name>-<page>.${req.to}.`)
    }
    if (scaleReduced) {
      warnings.push(`Raster scale was reduced on some pages to fit the pixel budget (maxOutputPixels).`)
    }

    return {
      ok: true,
      input: req.input,
      output: outputs[0] ?? req.output,
      outputs: outputs.length > 1 ? outputs : undefined,
      from: req.from,
      to: req.to,
      bytesIn,
      bytesOut,
      durationMs: Date.now() - started,
      warnings,
    }
  }

  private async toText(
    doc: PdfDocumentLike,
    req: ConvertRequest,
    ctx: ConvertContext,
    bytesIn: number,
    started: number,
  ): Promise<ConvertResult> {
    const totalPages = doc.numPages
    const explicitSelection = Boolean(req.options.pages)
    const selected = req.options.pages ? parsePageRange(req.options.pages, totalPages) : pageRange(totalPages)
    const maxPdfPages = ctx.limits?.maxPdfPages
    if (!explicitSelection && maxPdfPages && totalPages > maxPdfPages) {
      return failErr(req, convertError('invalid_input', `PDF has ${totalPages} pages, above the ${maxPdfPages}-page text-extraction limit.`, {
        hint: `Use pages (e.g. '1-${maxPdfPages}') to select, or raise 'maxPdfPages' in the plugin config.`,
      }))
    }
    if (explicitSelection && maxPdfPages && selected.length > maxPdfPages) {
      return failErr(req, convertError('invalid_input', `${selected.length} pages selected, above the ${maxPdfPages}-page text-extraction limit.`, {
        hint: `Narrow the pages selection or raise 'maxPdfPages' in the plugin config.`,
      }))
    }
    const warnings: string[] = []

    const pageTexts: string[] = []
    for (const n of selected) {
      if (ctx.signal?.aborted) {
        return fail(req, 'cancelled', 'Conversion cancelled.')
      }
      const page = await doc.getPage(n)
      try {
        const content = await page.getTextContent()
        pageTexts.push(itemsToText(content.items as TextItemLike[]))
      } finally {
        page.cleanup()
      }
    }

    if (req.options.ocr === true) {
      if (!this.resolve) {
        return failErr(req, convertError('conversion_failed', 'OCR is unavailable in this build (no binary resolver).'))
      }
      const engine = await resolveOcrEngine(this.resolve, ctx.logger)
      if (!engine) {
        return failErr(req, convertError('missing_dependency', 'OCR was requested but no OCR engine is available.', {
          missing: [TESSERACT],
          hint: `Install hint (${process.platform}): ${TESSERACT.installHint[platformKey()]} - or reinstall the plugin so its bundled tesseract.js fallback is present.`,
        }))
      }
      const ocrLang = req.options.ocrLang ?? 'chi_sim+eng'
      // The bundled engine needs language data that is NOT downloaded
      // implicitly: without a cached pack we fail with guidance instead.
      if (engine.name === 'tesseract.js' && !(await ocrLanguagesCached(ocrLang))) {
        return failErr(req, convertError('missing_dependency', `OCR language data for '${ocrLang}' is not cached yet.`, {
          missing: [OCR_LANGUAGE_DATA],
          hint: 'Ask the agent to run install_ocr_dependencies (downloads about 10-30 MB per language into the plugin cache), or install a local Tesseract CLI and set tesseractPath if needed.',
        }))
      }
      if (pageTexts.some((t) => t.trim().length > 0)) {
        warnings.push('A text layer was detected; OCR was used anyway because ocr: true.')
      }
      // OCR needs legible pixels: default to a higher density than rasterization.
      const scale = Math.max((req.options.dpi ?? 200) / 72, 200 / 72)
      const maxOutputPixels = ctx.limits?.maxOutputPixels
      const ocrTexts: string[] = []
      for (const n of selected) {
        if (ctx.signal?.aborted) {
          return fail(req, 'cancelled', 'Conversion cancelled.')
        }
        const page = await doc.getPage(n)
        try {
          let renderScale = scale
          if (maxOutputPixels) {
            const viewport = page.getViewport({ scale })
            const pixels = viewport.width * viewport.height
            if (pixels > maxOutputPixels) {
              // Recognition quality suffers on tiny rasters, so clamp gently
              // (2x the pixel budget) and say so.
              renderScale = scale * Math.sqrt((maxOutputPixels * 2) / pixels)
              warnings.push('OCR render scale was reduced on some pages to fit the pixel budget; recognition quality may drop.')
            }
          }
          const png = await renderPage(page, renderScale, { to: 'png', quality: 100 })
          ocrTexts.push((await engine.recognizePng(png, ocrLang, ctx)).trim())
        } catch (err) {
          if (err instanceof OcrLanguageMissingError) {
            return failErr(req, convertError('missing_dependency', `The local Tesseract is missing language data for '${ocrLang}'.`, {
              hint: `Install the '${ocrLang}' traineddata for your Tesseract, or pick an ocr_lang it provides.`,
            }))
          }
          throw err
        } finally {
          page.cleanup()
        }
      }
      warnings.push(`OCR via ${engine.name} (${ocrLang}); quality depends on scan quality.`)
      pageTexts.length = 0
      pageTexts.push(...ocrTexts)
    } else if (pageTexts.every((t) => t.trim().length === 0)) {
      warnings.push('No extractable text found - this may be a scanned PDF. Re-run with ocr: true.')
    }

    const text = pageTexts.join('\n\n').replace(/\n{4,}/g, '\n\n\n') + '\n'
    await writeFileAtomic(req.output, text)
    if (selected.length < totalPages) {
      warnings.push(`Converted page(s) ${selected.join(', ')} of ${totalPages} (pages option).`)
    }
    return {
      ok: true,
      input: req.input,
      output: req.output,
      from: req.from,
      to: req.to,
      bytesIn,
      bytesOut: Buffer.byteLength(text),
      durationMs: Date.now() - started,
      warnings,
    }
  }
}

function pageRange(totalPages: number): number[] {
  return Array.from({ length: totalPages }, (_, i) => i + 1)
}

/** Rasterize one page at a scale; white background for JPEG, transparent PNG otherwise. */
async function renderPage(
  page: PdfPageLike,
  scale: number,
  opts: { background?: string; quality: number; to: 'png' | 'jpg' },
): Promise<Buffer> {
  const viewport = page.getViewport({ scale })
  const width = Math.max(1, Math.ceil(viewport.width))
  const height = Math.max(1, Math.ceil(viewport.height))
  const canvas = createCanvas(width, height)
  const cctx = canvas.getContext('2d')
  if (opts.background) {
    cctx.fillStyle = opts.background
    cctx.fillRect(0, 0, width, height)
  }
  await page.render({ canvasContext: cctx, viewport }).promise
  return opts.to === 'png' ? canvas.encode('png') : canvas.encode('jpeg', opts.quality)
}

function fail(req: ConvertRequest, code: 'cancelled', message: string): ConvertResult {
  return { ok: false, input: req.input, from: req.from, to: req.to, error: convertError(code, message) }
}

function failErr(req: ConvertRequest, error: import('../types.js').ConvertError): ConvertResult {
  return { ok: false, input: req.input, from: req.from, to: req.to, error }
}

function platformKey(): 'win32' | 'darwin' | 'linux' {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
}

/** Minimal per-page text assembly: keep line breaks, avoid word-gluing. */
function itemsToText(items: TextItemLike[]): string {
  const lines: string[] = []
  let line = ''
  for (const item of items) {
    const s = item.str
    if (s === undefined) continue
    if (s.length > 0) {
      if (line.length > 0 && !line.endsWith(' ') && !s.startsWith(' ')) line += ' '
      line += s
    }
    if (item.hasEOL) {
      lines.push(line.trimEnd())
      line = ''
    }
  }
  if (line.trimEnd().length > 0) lines.push(line.trimEnd())
  return lines.join('\n').trimEnd()
}

function withPageNumber(output: string, page: number, pad: number): string {
  const { dir, name, ext } = path.parse(output)
  return path.join(dir, `${name}-${String(page).padStart(pad, '0')}${ext}`)
}
