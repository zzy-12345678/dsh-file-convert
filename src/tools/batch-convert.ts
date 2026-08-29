import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConversionRouter, FormatId, Logger } from '../core/index.js'
import { formatFromExtension, parseFormatArg } from '../core/index.js'
import { batchOutputPath } from '../core/index.js'
import { detectFile, DetectError } from '../core/index.js'
import type { Config } from '../config.js'
import { formatBatchSummary, formatFailure, type BatchSummary } from '../format.js'

const MAX_AUTO_DETECT = 500
const MAX_CONCURRENCY = 4

export function createBatchConvertTool(router: ConversionRouter, config: Config, logger: Logger) {
  return defineTool({
    name: 'batch_convert',
    description:
      'Convert every matching file in a directory in one call (top level only), e.g. "convert all JPGs in this folder to WebP". Local execution, no uploads. Outputs land in <input_dir>/output by default; existing outputs are skipped unless overwrite is true.',
    parameters: {
      input_dir: { type: 'string', required: true, description: 'Directory containing the input files (non-recursive).' },
      output_format: {
        type: 'string',
        required: true,
        description: 'Target format: png, jpg, webp, svg, pdf, json, yaml, csv or txt.',
      },
      input_format: {
        type: 'string',
        description: 'Only convert files of this source format (e.g. jpg). Omit to auto-detect convertible files.',
      },
      output_dir: { type: 'string', description: 'Output directory. Default: <input_dir>/output.' },
      overwrite: { type: 'boolean', description: 'Replace existing outputs. Default false (skip them).' },
      quality: { type: 'integer', description: 'JPEG/WebP quality 1-100 (default from plugin config, 85).' },
      dpi: { type: 'integer', description: 'Rasterization DPI for PDF/SVG inputs (default from plugin config, 150).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: config.timeoutMs * 4,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const to = parseFormatArg(args.output_format)
      if (!to) throw new Error(`Unknown output format '${args.output_format}'. Supported: png, jpg, webp, svg, pdf, json, yaml, csv, txt.`)
      const fromFilter: FormatId | undefined = args.input_format
        ? (() => {
            const parsed = parseFormatArg(args.input_format as string)
            if (!parsed) throw new Error(`Unknown source format '${args.input_format}'.`)
            return parsed
          })()
        : undefined

      const inputDir = args.input_dir
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(inputDir, { withFileTypes: true })
      } catch (err) {
        throw new Error(`Cannot read directory ${inputDir}: ${err instanceof Error ? err.message : String(err)}`)
      }
      const files = entries.filter((e) => e.isFile()).map((e) => path.join(inputDir, e.name)).sort()

      const candidates: string[] = []
      for (const file of files) {
        if (candidates.length >= MAX_AUTO_DETECT) break
        if (fromFilter) {
          const ext = path.extname(file).replace(/^\./, '')
          if (formatFromExtension(ext) === fromFilter) candidates.push(file)
          continue
        }
        try {
          const { detection } = await detectFile(file)
          if (detection.format !== to && router.route(detection.format, to)) candidates.push(file)
        } catch {
          /* unknown formats are simply not candidates */
        }
      }

      if (candidates.length === 0) {
        return `No convertible files found in ${inputDir}${fromFilter ? ` with format ${fromFilter}` : ''}.`
      }

      const outputDir = args.output_dir ?? path.join(inputDir, 'output')
      await fs.mkdir(outputDir, { recursive: true })

      const summary: BatchSummary = {
        inputDir,
        outputDir,
        outputFormat: to,
        converted: [],
        skipped: [],
        failed: [],
      }

      // The pool adapts to the strictest involved converter (V0.1: all support parallel).
      let next = 0
      let aborted = false
      const worker = async () => {
        while (next < candidates.length) {
          if (exec.signal.aborted) {
            aborted = true
            return
          }
          const file = candidates[next++]
          const result = await router.convertFile(
            {
              input: file,
              outputFormat: to,
              output: batchOutputPath(outputDir, file, to),
              overwrite: args.overwrite,
              quality: args.quality,
              dpi: args.dpi,
            },
            { logger, signal: exec.signal },
          )
          const name = path.basename(file)
          if (result.ok) {
            summary.converted.push(`${name} -> ${path.relative(outputDir, result.output) || path.basename(result.output)}`)
          } else if (result.error.code === 'output_exists') {
            summary.skipped.push(name)
          } else {
            summary.failed.push(`${name}: ${result.error.message}`)
          }
        }
      }
      const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, os.cpus().length))
      await Promise.all(Array.from({ length: concurrency }, worker))

      if (aborted) {
        summary.failed.push(`Cancelled with ${candidates.length - next} files not processed.`)
      }
      return formatBatchSummary(summary)
    },
  })
}

// DetectError is re-exported for tests that assert detection failures.
export { DetectError }
