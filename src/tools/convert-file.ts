import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConversionRouter, Logger } from '../core/index.js'
import type { Config } from '../config.js'
import { formatConvertResult, formatFailure } from '../format.js'

export function createConvertFileTool(router: ConversionRouter, config: Config, logger: Logger) {
  return defineTool({
    name: 'convert_file',
    description:
      'Convert one file between supported formats, fully local: PNG/JPG/WEBP/SVG images, PDF (to PNG/JPG/TXT), JSON/YAML/CSV data. No API keys, no uploads, no token cost. The output file defaults to the input directory with the new extension. Use inspect_file first when the input is unclear, and list_conversions to see what is supported.',
    parameters: {
      input: { type: 'string', required: true, description: 'Absolute path of the file to convert.' },
      output_format: {
        type: 'string',
        required: true,
        description: 'Target format: png, jpg, webp, svg, pdf, json, yaml, csv or txt. Aliases like jpeg/yml are accepted.',
      },
      output: { type: 'string', description: 'Optional absolute output path. Defaults to next to the input file.' },
      overwrite: { type: 'boolean', description: 'Replace the output file if it exists. Default false.' },
      quality: { type: 'integer', description: 'JPEG/WebP quality 1-100 (default from plugin config, 85).' },
      dpi: { type: 'integer', description: 'Rasterization DPI for PDF/SVG inputs (default from plugin config, 150).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const result = await router.convertFile(
        {
          input: args.input,
          outputFormat: args.output_format,
          output: args.output,
          overwrite: args.overwrite,
          quality: args.quality,
          dpi: args.dpi,
        },
        { logger, signal: exec.signal },
      )
      if (!result.ok) throw new Error(formatFailure(result.error))
      return formatConvertResult(result)
    },
  })
}
