import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Logger } from '../core/index.js'
import { FFMPEG, FFPROBE, resolveBinary } from '../core/index.js'
import { downloadBinary, readCacheManifest } from '../core/binaries/download.js'
import type { Config } from '../config.js'
import { formatBytes } from '../format.js'

/**
 * One explicit, user-approved path to media support: downloads pinned static
 * ffmpeg/ffprobe builds (FFmpeg 6.1.1) into the plugin cache via the
 * npmmirror binary CDN, with the GitHub release as a sha256-identical
 * fallback. System installs always keep priority; this only fills the gap.
 */
export function createInstallMediaTool(config: Config, logger: Logger) {
  return defineTool({
    name: 'install_media_dependencies',
    description:
      'Download pinned static ffmpeg and ffprobe builds (FFmpeg 6.1.1, about 56 MB total on Windows as two ~28 MB downloads) into the plugin cache (~/.dsh-file-convert/bin), so mp4/mov/wav conversions and video optimize_file work without a system install. Served from the npmmirror binary CDN with the GitHub release as fallback, both sha256-verified. Ask the user for consent before calling. Skips what is already available; a system ffmpeg keeps priority over the cache.',
    parameters: {
      force: {
        type: 'boolean',
        description: 'Re-download even if a cached copy exists (e.g. after a corrupted download). Default false.',
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
      const manifest = await readCacheManifest()
      for (const dep of [FFMPEG, FFPROBE]) {
        const existing = await resolveBinary(dep, overrides, logger)
        if (existing && args.force !== true) {
          lines.push(`= ${dep.name}: already available at ${existing}`)
          if (!manifest[dep.name]) {
            lines.push(`~ ${dep.name}: the cached copy predates the manifest - run with force: true once to upgrade to a sha256-verified build`)
          }
          continue
        }
        logger.info(`downloading ${dep.name} into the plugin cache...`)
        const outcome = await downloadBinary(dep, {
          timeoutMs: Math.max(config.timeoutMs, 900_000),
          signal: exec.signal,
          force: args.force === true,
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
