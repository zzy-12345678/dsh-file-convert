import fs from 'node:fs/promises'
import path from 'node:path'
import { fileTypeFromFile } from 'file-type'
import { convertError } from './errors.js'
import { formatFromExtension } from './formats.js'
import type { Detection, FormatId } from './types.js'

/** MIME types file-type can report that map 1:1 onto a supported format. */
const MIME_TO_FORMAT: Partial<Record<string, FormatId>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

const TEXT_SNIFF_BYTES = 512
/** Whole-file JSON.parse is only attempted up to this size; larger files fall back to the extension. */
const JSON_SNIFF_LIMIT = 1_000_000
const SVG_MIME = 'image/svg+xml'

export interface DetectOutcome {
  detection: Detection
  warnings: string[]
}

export class DetectError extends Error {
  constructor(readonly error: import('./types.js').ConvertError) {
    super(error.message)
  }
}

/**
 * Detect the format of a file. Priority: binary magic bytes (file-type) →
 * SVG content → JSON content → extension → YAML document marker. When content
 * and extension disagree, content wins and a warning is returned — users
 * rename files wrongly all the time.
 */
export async function detectFile(input: string): Promise<DetectOutcome> {
  const stat = await fs.stat(input).catch(() => null)
  if (!stat) {
    throw new DetectError(convertError('input_not_found', `Input file not found: ${input}`))
  }
  if (stat.isDirectory()) {
    throw new DetectError(convertError('invalid_input', `Input is a directory, not a file: ${input}`))
  }

  const warnings: string[] = []
  const ext = path.extname(input).replace(/^\./, '')
  const extFormat = ext ? formatFromExtension(ext) : null

  // 1. Binary formats via magic bytes.
  const magic = await fileTypeFromFile(input).catch(() => undefined)
  const magicFormat = magic ? MIME_TO_FORMAT[magic.mime] : undefined

  // 2. SVG is text-based; file-type does not report it.
  const svgLike = magicFormat ? false : await looksLikeSvg(input)

  const detected: FormatId | null = magicFormat ?? (svgLike ? 'svg' : null)
  if (detected) {
    if (extFormat && extFormat !== detected) {
      warnings.push(
        `File extension suggests ${extFormat} but content is ${detected}; using ${detected}.`,
      )
    }
    return {
      detection: { format: detected, confidence: 'magic', mime: magic?.mime ?? SVG_MIME },
      warnings,
    }
  }

  // 3. JSON parses successfully — essentially zero false positives when the
  //    content starts with { or [ (scalars like `123` stay ambiguous).
  if (await isJsonContent(input)) {
    if (extFormat && extFormat !== 'json') {
      warnings.push(
        `File extension suggests ${extFormat} but content parses as JSON; using json.`,
      )
    }
    return { detection: { format: 'json', confidence: 'magic', mime: 'application/json' }, warnings }
  }

  // 4. Extension mapping (csv/txt cannot be told apart from plain text by content).
  if (extFormat) {
    return { detection: { format: extFormat, confidence: 'extension', mime: undefined }, warnings }
  }

  // 5. YAML document marker, for extension-less files only — a leading `---`
  //    line is a strong YAML signal but not proof (markdown frontmatter, rules).
  if (await startsWithYamlMarker(input)) {
    return { detection: { format: 'yaml', confidence: 'guess', mime: 'application/yaml' }, warnings }
  }

  throw new DetectError(
    convertError('unknown_format', `Cannot determine the format of ${input}`, {
      hint: 'inspect_file it first, or rename it with a known extension (png, jpg, webp, svg, pdf, json, yaml, csv, txt).',
    }),
  )
}

async function readHead(input: string, bytes: number): Promise<string> {
  return fs.open(input, 'r').then(async (handle) => {
    try {
      const buffer = Buffer.alloc(bytes)
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
      return buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '')
    } finally {
      await handle.close()
    }
  }).catch(() => '')
}

async function looksLikeSvg(input: string): Promise<boolean> {
  return (await readHead(input, TEXT_SNIFF_BYTES)).includes('<svg')
}

/** True when the whole file JSON-parses and starts with an unambiguous container. */
async function isJsonContent(input: string): Promise<boolean> {
  const stat = await fs.stat(input).catch(() => null)
  if (!stat || stat.size === 0 || stat.size > JSON_SNIFF_LIMIT) return false
  const text = await fs.readFile(input, 'utf8').catch(() => '')
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

async function startsWithYamlMarker(input: string): Promise<boolean> {
  return /^---\s*(\r?\n|$)/.test((await readHead(input, 64)).trimStart())
}
