import type { FormatCategory, FormatId, FormatMeta } from './types.js'

/** Single source of truth for format metadata. */
export const FORMATS: Record<FormatId, FormatMeta> = {
  pdf: { category: 'document', extensions: ['.pdf'], mime: 'application/pdf' },
  png: { category: 'image', extensions: ['.png'], mime: 'image/png' },
  jpg: { category: 'image', extensions: ['.jpg', '.jpeg'], mime: 'image/jpeg' },
  webp: { category: 'image', extensions: ['.webp'], mime: 'image/webp' },
  svg: { category: 'image', extensions: ['.svg'], mime: 'image/svg+xml' },
  json: { category: 'data', extensions: ['.json'], mime: 'application/json' },
  yaml: { category: 'data', extensions: ['.yaml', '.yml'], mime: 'application/yaml' },
  csv: { category: 'data', extensions: ['.csv'], mime: 'text/csv' },
  txt: { category: 'text', extensions: ['.txt'], mime: 'text/plain' },
}

export const FORMAT_IDS = Object.keys(FORMATS) as FormatId[]

const EXT_TO_FORMAT = new Map<string, FormatId>()
for (const [id, meta] of Object.entries(FORMATS) as [FormatId, FormatMeta][]) {
  for (const ext of meta.extensions) EXT_TO_FORMAT.set(ext.slice(1).toLowerCase(), id)
}

/** Input aliases users (and agents) type instead of canonical ids. */
const ALIASES: Record<string, FormatId> = {
  jpeg: 'jpg',
  jpe: 'jpg',
  yml: 'yaml',
}

/** Resolve a free-text format name ('JPEG', '.yml', 'webp') to a FormatId. */
export function parseFormatArg(value: string): FormatId | null {
  const key = value.trim().toLowerCase().replace(/^\./, '')
  return ALIASES[key] ?? (key in FORMATS ? (key as FormatId) : null)
}

/** Extension (without dot) → FormatId, e.g. 'jpeg' → 'jpg'. */
export function formatFromExtension(ext: string): FormatId | null {
  return EXT_TO_FORMAT.get(ext.toLowerCase()) ?? (ALIASES[ext.toLowerCase()] ?? null)
}

/** Canonical output extension for a format, e.g. 'jpg' → '.jpg'. */
export function canonicalExtension(format: FormatId): string {
  return FORMATS[format].extensions[0]
}

export function formatCategory(format: FormatId): FormatCategory {
  return FORMATS[format].category
}
