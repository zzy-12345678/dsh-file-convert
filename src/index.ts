import type { Context } from '@deepseek-ai/cordis'
import { createRouter, type Logger } from './core/index.js'
import { Config, type Config as ConvertConfig } from './config.js'
import { createConvertFileTool } from './tools/convert-file.js'
import { createBatchConvertTool } from './tools/batch-convert.js'
import { createInspectFileTool } from './tools/inspect-file.js'
import { createListConversionsTool } from './tools/list-conversions.js'
import { createOptimizeFileTool } from './tools/optimize-file.js'
import { createInstallMediaTool } from './tools/install-media.js'

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
  const router = createRouter({
    quality: config.quality,
    dpi: config.dpi,
    timeoutMs: config.timeoutMs,
    outputRoots: config.outputRoots,
    binaryOverrides: {
      ...(config.ffmpegPath ? { ffmpegPath: config.ffmpegPath } : {}),
      ...(config.ffprobePath ? { ffprobePath: config.ffprobePath } : {}),
      ...(config.sofficePath ? { sofficePath: config.sofficePath } : {}),
      ...(config.ghostscriptPath ? { ghostscriptPath: config.ghostscriptPath } : {}),
      ...(config.pythonPath ? { pythonPath: config.pythonPath } : {}),
    },
  })

  ctx.tools.register(createConvertFileTool(router, config, logger))
  ctx.tools.register(createBatchConvertTool(router, config, logger))
  ctx.tools.register(createInspectFileTool(router, config, logger))
  ctx.tools.register(createListConversionsTool(router, logger))
  ctx.tools.register(createOptimizeFileTool(router, config, logger))
  ctx.tools.register(createInstallMediaTool(config, logger))

  logger.info('dsh-file-convert loaded: 6 tools registered (26 conversions; media via install_media_dependencies, office via LibreOffice)')
}

function isLogger(value: unknown): value is Logger {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Logger).info === 'function' &&
    typeof (value as Logger).warn === 'function'
  )
}
