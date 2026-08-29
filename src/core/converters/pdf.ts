import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import './pdf-env.js'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { convertError } from '../errors.js'
import type {
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

  /** Multi-page PDFs produce `<base>-<n>.<ext>` files; a single page writes exactly `output`. */
  private async toImages(
    doc: PdfDocumentLike,
    req: ConvertRequest,
    ctx: ConvertContext,
    bytesIn: number,
    started: number,
  ): Promise<ConvertResult> {
    const pages = doc.numPages
    const scale = (req.options.dpi ?? 150) / 72 // PDFs have no intrinsic pixel size; 150 is a sane default.
    const pad = String(pages).length
    const outputs: string[] = []
    let bytesOut = 0

    for (let n = 1; n <= pages; n++) {
      if (ctx.signal?.aborted) {
        return fail(req, 'cancelled', 'Conversion cancelled.')
      }
      const page = await doc.getPage(n)
      try {
        const viewport = page.getViewport({ scale })
        const width = Math.max(1, Math.ceil(viewport.width))
        const height = Math.max(1, Math.ceil(viewport.height))
        const canvas = createCanvas(width, height)
        const cctx = canvas.getContext('2d')
        if (req.to === 'jpg') {
          // JPEG has no alpha; the pdf.js canvas starts transparent and would encode black.
          cctx.fillStyle = req.options.background ?? '#ffffff'
          cctx.fillRect(0, 0, width, height)
        }
        await page.render({ canvasContext: cctx, viewport }).promise
        const buffer =
          req.to === 'png' ? await canvas.encode('png') : await canvas.encode('jpeg', req.options.quality ?? 85)
        const out = pages === 1 ? req.output : withPageNumber(req.output, n, pad)
        await fs.writeFile(out, buffer)
        bytesOut += buffer.byteLength
        outputs.push(out)
      } finally {
        page.cleanup()
      }
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
      warnings:
        pages > 1
          ? [`PDF has ${pages} pages; wrote ${pages} files named <name>-<page>.${req.to}.`]
          : [],
    }
  }

  private async toText(
    doc: PdfDocumentLike,
    req: ConvertRequest,
    ctx: ConvertContext,
    bytesIn: number,
    started: number,
  ): Promise<ConvertResult> {
    const pageTexts: string[] = []
    for (let n = 1; n <= doc.numPages; n++) {
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
    const text = pageTexts.join('\n\n').replace(/\n{4,}/g, '\n\n\n') + '\n'
    await fs.writeFile(req.output, text, 'utf8')
    return {
      ok: true,
      input: req.input,
      output: req.output,
      from: req.from,
      to: req.to,
      bytesIn,
      bytesOut: Buffer.byteLength(text),
      durationMs: Date.now() - started,
      warnings: pageTexts.every((t) => t.trim().length === 0)
        ? ['No extractable text found - this may be a scanned PDF.']
        : [],
    }
  }
}

function fail(req: ConvertRequest, code: 'cancelled', message: string): ConvertResult {
  return { ok: false, input: req.input, from: req.from, to: req.to, error: convertError(code, message) }
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
  const ext = path.extname(output)
  const base = output.slice(0, output.length - ext.length)
  return `${base}-${String(page).padStart(pad, '0')}${ext}`
}
