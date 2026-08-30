import fs from 'node:fs/promises'
import { parse as csvParse } from 'csv-parse/sync'
import { stringify as csvStringify } from 'csv-stringify/sync'
import yaml from 'js-yaml'
import { writeFileAtomic } from '../utils/write-file.js'
import { convertError } from '../errors.js'
import type {
  ConvertContext,
  ConvertRequest,
  ConvertResult,
  Converter,
  ConversionCapability,
} from '../types.js'

/**
 * JSON / YAML / CSV share one intermediate representation (a plain JS value):
 * three readers + three writers cover every pair, including YAML↔CSV.
 */
export class DataConverter implements Converter {
  readonly id = 'data'
  readonly concurrency = 4
  readonly binaryDeps = []

  readonly capabilities: ConversionCapability[] = [
    { from: 'json', to: 'yaml' },
    { from: 'yaml', to: 'json' },
    { from: 'json', to: 'csv' },
    { from: 'csv', to: 'json' },
    { from: 'yaml', to: 'csv' },
    { from: 'csv', to: 'yaml' },
  ]

  async convert(req: ConvertRequest, ctx: ConvertContext): Promise<ConvertResult> {
    const started = Date.now()
    const from = req.from
    const to = req.to
    const readable = from === 'json' || from === 'yaml' || from === 'csv'
    const writable = to === 'json' || to === 'yaml' || to === 'csv'
    if (!readable || !writable) {
      return {
        ok: false,
        input: req.input,
        from,
        to,
        error: convertError('unsupported_conversion', `DataConverter handles json/yaml/csv only, got ${from} -> ${to}.`),
      }
    }
    try {
      const raw = await fs.readFile(req.input, 'utf8')
      const bytesIn = Buffer.byteLength(raw)
      const value = this.read(from, raw, req.options.delimiter)
      const text = this.write(to, value, req.options.indent)
      await writeFileAtomic(req.output, text)
      return {
        ok: true,
        input: req.input,
        output: req.output,
        from: req.from,
        to: req.to,
        bytesIn,
        bytesOut: Buffer.byteLength(text),
        durationMs: Date.now() - started,
        warnings: [],
      }
    } catch (err) {
      // Reader/parser problems are invalid_input; everything else is backend failure.
      const code = err instanceof ParseError ? 'invalid_input' : 'conversion_failed'
      return {
        ok: false,
        input: req.input,
        from: req.from,
        to: req.to,
        error: convertError(code, `Failed to convert ${req.from} → ${req.to}`, {
          detail: err instanceof Error ? err.message : String(err),
        }),
      }
    }
  }

  private read(from: 'json' | 'yaml' | 'csv', raw: string, delimiter?: string): unknown {
    const text = raw.replace(/^\uFEFF/, '') // strip UTF-8 BOM (Excel exports)
    try {
      if (from === 'json') return JSON.parse(text)
      if (from === 'yaml') return yaml.load(text)
      return csvParse(text, {
        bom: true,
        columns: true,
        skip_empty_lines: true,
        delimiter: delimiter ?? sniffDelimiter(text),
      }) as unknown
    } catch (err) {
      throw new ParseError(err instanceof Error ? err.message : String(err))
    }
  }

  private write(to: 'json' | 'yaml' | 'csv', value: unknown, indent?: number): string {
    if (to === 'json') return JSON.stringify(value, null, indent ?? 2) + '\n'
    if (to === 'yaml') {
      return yaml.dump(value, { indent: indent ?? 2, lineWidth: 1000, noRefs: true })
    }
    const records = toRecords(value)
    return csvStringify(records, { header: true })
  }
}

class ParseError extends Error {}

/** CSV needs an array of flat objects; anything else is normalized into one. */
function toRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.map((item) => (isPlainItem(item) ? flattenRecord(item) : { value: item }))
  }
  if (value !== null && typeof value === 'object') {
    return [flattenRecord(value as Record<string, unknown>)]
  }
  return [{ value }]
}

function isPlainItem(item: unknown): item is Record<string, unknown> {
  return item !== null && typeof item === 'object' && !Array.isArray(item)
}

/** Nested objects become dot-notation columns; arrays are JSON-encoded cells. */
function flattenRecord(record: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(record)) {
    const column = prefix ? `${prefix}.${key}` : key
    if (isPlainItem(val)) {
      Object.assign(out, flattenRecord(val, column))
    } else if (Array.isArray(val)) {
      out[column] = JSON.stringify(val)
    } else {
      out[column] = val
    }
  }
  return out
}

/**
 * Pick the dominant delimiter among , ; \t from the first two lines.
 * Semicolon-separated exports are common in European Excel locales.
 */
function sniffDelimiter(text: string): string {
  const head = text.split(/\r?\n/, 2).join('\n')
  let best = ','
  let bestCount = 0
  for (const candidate of [',', ';', '\t']) {
    const count = head.split(candidate).length - 1
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}
