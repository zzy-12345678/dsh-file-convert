import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Logger } from '../core/index.js'
import { FFMPEG, FFPROBE, resolveBinary } from '../core/index.js'
import { downloadBinary } from '../core/binaries/download.js'
import type { Config } from '../config.js'
import { formatBytes } from '../format.js'

/**
 * One explicit, user-approved path to media support: downloads pinned static
 * ffmpeg/ffprobe builds from the npm registry into the plugin cache. System
 * installs always keep priority; this only fills the gap.
 */
export function createInstallMediaTool(config: Config, logger: Logger) {
  return defineTool({
    name: 'install_media_dependencies',
    description:
      'Download pinned static ffmpeg and ffprobe builds (roughly 80-140 MB depending on platform and pinned version; the exact size is reported after download, from the npmmirror registry by default with sha512 integrity verification) into the plugin cache (~/.dsh-file-convert/bin), so mp4/mov/wav conversions and video optimize_file work without a system install. Ask the user for consent before calling. Skips what is already available; a system ffmpeg keeps priority over the cache.',
    parameters: {
      force: {
        type: 'boolean',
        description: 'Re-download even if a cached copy exists (e.g. after a corrupted download). Default false.',
      },
      registry: {
        type: 'string',
        description:
          'npm registry to download from. Default: https://registry.npmmirror.com first with npmjs.org as fallback (pass a registry to pin one).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: Math.max(config.timeoutMs, 900_000), // big files, slow networks
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const overrides: Record<string, string> = {}
      if (config.ffmpegPath) overrides.ffmpegPath = config.ffmpegPath
      if (config.ffprobePath) overrides.ffprobePath = config.ffprobePath

      const lines: string[] = []
      for (const dep of [FFMPEG, FFPROBE]) {
        const existing = await resolveBinary(dep, overrides, logger)
        if (existing && args.force !== true) {
          lines.push(`= ${dep.name}: already available at ${existing}`)
          continue
        }
        logger.info(`downloading ${dep.name} into the plugin cache...`)
        const outcome = await downloadBinary(dep, {
          timeoutMs: Math.max(config.timeoutMs, 900_000),
          signal: exec.signal,
          force: args.force === true,
          registry: args.registry as string | undefined,
        })
        lines.push(`+ ${dep.name}: installed at ${outcome.path} (${formatBytes(outcome.bytes)}) - ${outcome.versionLine}`)
      }

      return [
        'Media dependencies ready:',
        ...lines,
        'No restart needed - the cache is checked on every conversion.',
      ].join('\n')
    },
  })
}
