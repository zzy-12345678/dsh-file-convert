import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConversionRouter, Logger } from '../core/index.js'
import { DetectError } from '../core/index.js'
import type { Config } from '../config.js'
import { formatFailure, formatInspect } from '../format.js'

export function createInspectFileTool(router: ConversionRouter, config: Config, logger: Logger) {
  void logger
  return defineTool({
    name: 'inspect_file',
    description:
      'Inspect a file before converting it: format (by content, not just extension), dimensions for images, page count / encryption / scanned-PDF detection for PDFs, record counts for JSON/YAML/CSV, plus file size. Returns JSON.',
    parameters: {
      input: { type: 'string', required: true, description: 'Absolute path of the file to inspect.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: Math.min(config.timeoutMs, 30_000),
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        return formatInspect(await router.inspect(args.input))
      } catch (err) {
        if (err instanceof DetectError) throw new Error(formatFailure(err.error))
        throw err
      }
    },
  })
}
