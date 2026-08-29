import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConversionRouter, Logger } from '../core/index.js'
import { formatConversionList } from '../format.js'

export function createListConversionsTool(router: ConversionRouter, logger: Logger) {
  void logger
  return defineTool({
    name: 'list_conversions',
    description:
      'List every conversion dsh-file-convert supports on this machine, including which ones are unavailable because an external tool is missing. Call this before converting when unsure whether a pair is supported.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      return formatConversionList(await router.listConversions())
    },
  })
}
