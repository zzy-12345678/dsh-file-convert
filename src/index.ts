import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRouter, type Logger } from './core/index.js'
import { Config, type Config as ConvertConfig } from './config.js'
import { createConvertFileTool } from './tools/convert-file.js'
import { createBatchConvertTool } from './tools/batch-convert.js'
import { createInspectFileTool } from './tools/inspect-file.js'
import { createListConversionsTool } from './tools/list-conversions.js'
import { createOptimizeFileTool } from './tools/optimize-file.js'
import { createInstallMediaTool } from './tools/install-media.js'
import { createInstallOcrTool } from './tools/install-ocr.js'
import { createOpenUiTool } from './tools/open-ui.js'
import { createUiHandler, type UiHandler } from './ui/server.js'

export { Config } from './config.js'
// Library consumers (CLI, MCP wrapper, tests) can import the whole core
// surface from the package root; the DSH loader only reads name/inject/apply.
export * from './core/index.js'

export const name = 'dsh-file-convert'
export const inject = ['tools', 'webServer']

/** Minimal structural view of the DSH host's webServer service. */
interface DshWebServer {
  register(route: {
    kind: 'prefix' | 'exact'
    path: string
    handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  }): void
}

/** Path the drag-and-drop UI is mounted under on the DSH web server. */
export const UI_MOUNT_PATH = '/dsh-file-convert'

/**
 * Module-level claim so double apply (host reload, extra scopes) mounts the
 * hosted UI exactly once per process: the host's webServer registry is global
 * and treats a duplicate prefix route as a fatal load failure. Claimed
 * synchronously, because two applies can race before either handler resolves.
 */
let hostedMount: { webServer: DshWebServer; handle?: UiHandler } | undefined

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
      ...(config.tesseractPath ? { tesseractPath: config.tesseractPath } : {}),
    },
    maxInputBytes: config.maxInputMb * 1024 * 1024,
    maxPdfPages: config.maxPdfPages,
    maxOutputPixels: config.maxOutputPixels,
  })

  ctx.tools.register(createConvertFileTool(router, config, logger))
  ctx.tools.register(createBatchConvertTool(router, config, logger))
  ctx.tools.register(createInspectFileTool(router, config, logger))
  ctx.tools.register(createListConversionsTool(router, logger))
  ctx.tools.register(createOptimizeFileTool(router, config, logger))
  ctx.tools.register(createInstallMediaTool(config, logger))
  ctx.tools.register(createInstallOcrTool(config, logger))

  const openUi = createOpenUiTool({
    timeoutMs: config.uiTimeoutMin * 60_000,
    maxUploadBytes: config.maxInputMb * 1024 * 1024,
    logger,
  })
  ctx.tools.register(openUi.tool)
  if (config.uiAutoStart) {
    void openUi.ensure().then((handle) => logger.info(`web UI available at ${handle.url}`))
  }

  // Host the drag-and-drop UI natively: mounted on the DSH web server under
  // /dsh-file-convert, where the client bundle's iframe view loads it. The
  // hosted handler trusts the host's gate instead of its own token.
  const teardowns: Array<() => Promise<void>> = []
  const webServer = (ctx as Context & { webServer?: DshWebServer }).webServer
  if (webServer?.register && !hostedMount) {
    hostedMount = { webServer }
    void createUiHandler({
      auth: 'hosted',
      basePath: UI_MOUNT_PATH,
      timeoutMs: config.uiTimeoutMin * 60_000,
      maxUploadBytes: config.maxInputMb * 1024 * 1024,
      logger,
    })
      .then((handle) => {
        hostedMount!.handle = handle
        teardowns.push(() => handle.close())
        try {
          webServer.register({
            kind: 'prefix',
            path: UI_MOUNT_PATH,
            handler: (req, res) => {
              void handle.handle(req, res)
            },
          })
          logger.info(`drag-and-drop UI mounted at ${UI_MOUNT_PATH} on the DSH web server`)
        } catch (err) {
          // The host rejects duplicate prefixes fatally; never let our mount
          // take the whole desktop down - the standalone open_ui still works.
          logger.warn(`drag-and-drop UI mount skipped: ${err instanceof Error ? err.message : String(err)}`)
          void handle.close()
          if (hostedMount?.handle === handle) hostedMount = undefined
        }
      })
      .catch((err) => {
        logger.warn(`drag-and-drop UI handler failed: ${err instanceof Error ? err.message : String(err)}`)
        hostedMount = undefined
      })
  }

  // Best-effort teardown when the host unloads the plugin; if the host has no
  // dispose event the workspaces simply die with the process (they live in
  // the OS temp dir).
  try {
    ;(ctx as unknown as { on?(event: string, listener: () => void): unknown }).on?.('dispose', () => {
      void openUi.close()
      for (const teardown of teardowns.splice(0)) void teardown()
      if (hostedMount && !hostedMount.handle) hostedMount = undefined
    })
  } catch {
    /* host without a dispose event */
  }

  logger.info('dsh-file-convert loaded: 8 tools registered (26 conversions; media/ocr dependencies install on request; open_ui starts the standalone web UI)')
}

function isLogger(value: unknown): value is Logger {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Logger).info === 'function' &&
    typeof (value as Logger).warn === 'function'
  )
}
