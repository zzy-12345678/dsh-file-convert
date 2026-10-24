import { defineTool } from '@deepseek-ai/dsh-tools'
import { openBrowser, startUiServer, type UiServerHandle } from '../ui/server.js'
import type { Logger } from '../core/index.js'

export interface OpenUiToolOptions {
  /** Per-conversion deadline inside the UI (independent of the tools' timeoutMs). */
  timeoutMs: number
  maxUploadBytes: number
  logger: Logger
}

export interface OpenUiTool {
  tool: ReturnType<typeof defineTool>
  /** Start the server without opening a browser (used by uiAutoStart). */
  ensure(): Promise<UiServerHandle>
  /** Stop the server and drop its workspace; safe to call when never started. */
  close(): Promise<void>
}

/**
 * The `open_ui` tool hosts the drag-and-drop web UI inside the plugin
 * process: the first call starts the server (once) and opens the browser,
 * later calls return the running URL. The start promise is shared, so
 * concurrent calls never spawn two servers.
 */
export function createOpenUiTool(options: OpenUiToolOptions): OpenUiTool {
  let starting: Promise<UiServerHandle> | undefined

  const ensure = (): Promise<UiServerHandle> => {
    if (!starting) {
      starting = startUiServer({
        timeoutMs: options.timeoutMs,
        maxUploadBytes: options.maxUploadBytes,
      })
      // Allow a later retry if startup failed (port refused, assets missing).
      starting.catch(() => {
        starting = undefined
      })
    }
    return starting
  }

  const tool = defineTool({
    name: 'open_ui',
    description:
      'Open the local drag-and-drop conversion web UI in the browser and return its URL. Call this when the user wants a visual way to convert files by dropping them into a page instead of using convert_file arguments. The UI only serves this machine (127.0.0.1); files never leave it.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const handle = await ensure()
      openBrowser(handle.url)
      return `dsh-file-convert UI is running at ${handle.url} (opened in your browser; drag files in, pick a target format, download the results).`
    },
  })

  return {
    tool,
    ensure,
    close: async () => {
      if (!starting) return
      const handle = await starting.catch(() => undefined)
      starting = undefined
      if (handle) await handle.close()
    },
  }
}
