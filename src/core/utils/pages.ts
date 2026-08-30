import { convertError } from '../errors.js'
import type { ConvertError } from '../types.js'

export class PageRangeError extends Error {
  constructor(readonly error: ConvertError) {
    super(error.message)
  }
}

/**
 * Parse a one-based, inclusive page selection like "1-3,5,8-10" into a
 * deduplicated, ascending list of page numbers bounded by pageCount.
 * Throws PageRangeError (code: invalid_input) on malformed or out-of-range
 * selections so agents get a correction-friendly message.
 */
export function parsePageRange(spec: string, pageCount: number): number[] {
  const cleaned = spec.trim()
  if (!cleaned) {
    throw new PageRangeError(convertError('invalid_input', 'Page selection is empty.', {
      hint: 'Use one-based ranges like 1-3,5,8-10.',
    }))
  }
  if (!/^\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*$/.test(cleaned)) {
    throw new PageRangeError(convertError('invalid_input', `Invalid page selection: '${spec}'.`, {
      hint: 'Use one-based ranges like 1-3,5,8-10 (commas separate pages and ranges).',
    }))
  }

  const seen = new Set<number>()
  for (const part of cleaned.split(',')) {
    const [rawStart, rawEnd] = part.split('-').map((s) => s.trim())
    const start = Number.parseInt(rawStart, 10)
    const end = rawEnd === undefined ? start : Number.parseInt(rawEnd, 10)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      throw new PageRangeError(convertError('invalid_input', `Invalid page range '${part.trim()}' in '${spec}'.`, {
        hint: 'Ranges must be ascending, one-based and inclusive, e.g. 2-4.',
      }))
    }
    if (end > pageCount) {
      throw new PageRangeError(convertError('invalid_input', `Page ${end} is out of range: the document has ${pageCount} page(s).`, {
        hint: `Use page numbers between 1 and ${pageCount}.`,
      }))
    }
    for (let p = start; p <= end; p++) seen.add(p)
  }
  return [...seen].sort((a, b) => a - b)
}
