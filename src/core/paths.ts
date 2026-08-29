import path from 'node:path'
import { canonicalExtension } from './formats.js'
import type { FormatId } from './types.js'

/**
 * Default output for a single-file conversion: next to the source file, same
 * base name, canonical extension of the target format.
 */
export function defaultOutputPath(input: string, to: FormatId): string {
  const dir = path.dirname(input)
  const base = path.basename(input, path.extname(input))
  return path.join(dir, base + canonicalExtension(to))
}

/**
 * Default output for a batch conversion: under outputDir, same base name.
 * outputDir defaults to `<inputDir>/output` and is created by the caller.
 */
export function batchOutputPath(outputDir: string, input: string, to: FormatId): string {
  const base = path.basename(input, path.extname(input))
  return path.join(outputDir, base + canonicalExtension(to))
}
