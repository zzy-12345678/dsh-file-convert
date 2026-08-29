import type { Context } from '@deepseek-ai/cordis'
import { createRouter, type Logger } from './core/index.js'
import { Config, type Config as ConvertConfig } from './config.js'
import { createConvertFileTool } from './tools/convert-file.js'
import { createBatchConvertTool } from './tools/batch-convert.js'
import { createInspectFileTool } from './tools/inspect-file.js'
import { createListConversionsTool } from './tools/list-conversions.js'

export { Config } from './config.js'

export const name = 'dsh-file-convert'
export const inject = ['tools']

const CONSOLE_LOGGER: Logger = {
  debug: () => {},
  info: (msg) => console.log(`[dsh-file-convert] ${msg}`),
  warn: (msg) => console.warn(`[dsh-file-convert] ${msg}`),
  error: (msg) => console.error(`[dsh-file-convert] ${msg}`),
}

export function apply(ctx: Context, config: ConvertConfig) {
  const logger: Logger = isLogger(ctx.logger) ? ctx.logger : CONSOLE_LOGGER
  const router = createRouter(config)

  ctx.tools.register(createConvertFileTool(router, config, logger))
  ctx.tools.register(createBatchConvertTool(router, config, logger))
  ctx.tools.register(createInspectFileTool(router, config, logger))
  ctx.tools.register(createListConversionsTool(router, logger))

  logger.info('dsh-file-convert loaded: 4 tools registered (18 local conversions)')
}

function isLogger(value: unknown): value is Logger {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Logger).info === 'function' &&
    typeof (value as Logger).warn === 'function'
  )
}
