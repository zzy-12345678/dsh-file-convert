import fs from 'node:fs/promises'
import sharp from 'sharp'
import yaml from 'js-yaml'
import { parse as csvParse } from 'csv-parse/sync'
import './converters/pdf-env.js'
import type { Detection, InspectResult } from './types.js'

/**
 * Structured file facts so an agent can decide before converting.
 * Inspect is informational: parse problems degrade to `kind: 'unknown'`
 * instead of failing.
 */
export async function inspectFile(input: string, detection: Detection, bytes: number): Promise<InspectResult> {
  switch (detection.format) {
    case 'png':
    case 'jpg':
    case 'webp':
    case 'svg':
      return inspectImage(input, detection.format, bytes)
    case 'pdf':
      return inspectPdf(input, bytes)
    case 'json':
    case 'yaml':
    case 'csv':
    case 'txt':
      return inspectData(input, detection.format, bytes)
    default:
      return { kind: 'unknown', bytes, mime: detection.mime }
  }
}

async function inspectImage(input: string, format: InspectImageFormat, bytes: number): Promise<InspectResult> {
  try {
    const meta = await sharp(input).metadata()
    return {
      kind: 'image',
      format,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      channels: meta.channels,
      bytes,
    }
  } catch {
    return { kind: 'unknown', bytes }
  }
}

type InspectImageFormat = 'png' | 'jpg' | 'webp' | 'svg'

async function inspectPdf(input: string, bytes: number): Promise<InspectResult> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  try {
    const data = new Uint8Array(await fs.readFile(input))
    const doc = await getDocument({ data, verbosity: 0 }).promise
    try {
      let chars = 0
      for (let n = 1; n <= Math.min(3, doc.numPages); n++) {
        const page = await doc.getPage(n)
        const content = await page.getTextContent()
        for (const item of content.items as { str?: string }[]) chars += item.str?.trim().length ?? 0
        page.cleanup()
      }
      const pagesInspected = Math.min(3, doc.numPages)
      return {
        kind: 'pdf',
        pages: doc.numPages,
        encrypted: false,
        likelyScanned: chars / pagesInspected < 40,
        bytes,
      }
    } finally {
      await doc.cleanup().catch(() => undefined)
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'PasswordException') {
      return { kind: 'pdf', pages: 0, encrypted: true, likelyScanned: false, bytes }
    }
    return { kind: 'unknown', bytes }
  }
}

async function inspectData(input: string, format: 'json' | 'yaml' | 'csv' | 'txt', bytes: number): Promise<InspectResult> {
  try {
    const raw = (await fs.readFile(input, 'utf8')).replace(/^\uFEFF/, '')
    if (format === 'txt') return { kind: 'data', format, bytes }
    if (format === 'json') {
      const value = JSON.parse(raw)
      return { kind: 'data', format, records: Array.isArray(value) ? value.length : 1, bytes }
    }
    if (format === 'yaml') {
      const value = yaml.load(raw)
      return { kind: 'data', format, records: Array.isArray(value) ? value.length : 1, bytes }
    }
    const rows = csvParse(raw, { bom: true, columns: true, skip_empty_lines: true })
    return { kind: 'data', format, records: (rows as unknown[]).length, bytes }
  } catch {
    return { kind: 'unknown', bytes }
  }
}
