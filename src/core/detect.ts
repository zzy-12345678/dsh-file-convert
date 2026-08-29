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
 * Detect the format of a file: magic bytes first (file-type + SVG sniffing),
 * extension as fallback. When the two disagree, magic wins and a warning is
 * returned — users rename files wrongly all the time.
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

  // 3. Text formats can only be identified by extension in V0.1.
  if (extFormat) {
    return { detection: { format: extFormat, confidence: 'extension', mime: undefined }, warnings }
  }

  throw new DetectError(
    convertError('unknown_format', `Cannot determine the format of ${input}`, {
      hint: 'inspect_file it first, or rename it with a known extension (png, jpg, webp, svg, pdf, json, yaml, csv, txt).',
    }),
  )
}

async function looksLikeSvg(input: string): Promise<boolean> {
  const head = await fs.open(input, 'r').then(async (handle) => {
    try {
      const buffer = Buffer.alloc(TEXT_SNIFF_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, TEXT_SNIFF_BYTES, 0)
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  }).catch(() => '')
  return head.includes('<svg')
}
