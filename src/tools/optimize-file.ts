import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { BinaryDependency, ConversionRouter, Logger } from '../core/index.js'
import { DetectError, optimizeFile, resolveBinary } from '../core/index.js'
import { canonicalExtension } from '../core/index.js'
import type { Config } from '../config.js'
import { formatBytes, formatDuration, formatFailure } from '../format.js'

export function createOptimizeFileTool(router: ConversionRouter, config: Config, logger: Logger) {
  return defineTool({
    name: 'optimize_file',
    description:
      'Shrink a file toward a target size, fully local: MP4/MOV video via two-pass x264 (bitrate computed from the target, output is MP4) and JPG/WEBP/PNG images via encoder quality search. Not for GIF/PDF yet. Needs ffmpeg+ffprobe installed for video; images work without any external tool.',
    parameters: {
      input: { type: 'string', required: true, description: 'Absolute path of the file to shrink.' },
      target_size_mb: { type: 'number', required: true, description: 'Desired maximum output size in megabytes.' },
      output: {
        type: 'string',
        description:
          'Optional absolute output path. Defaults to next to the input with a "-min" suffix. If the plugin config sets outputRoots, the path must be inside one of them.',
      },
      overwrite: { type: 'boolean', description: 'Replace the output file if it exists. Default false.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: Math.max(config.timeoutMs, 600_000), // two-pass video needs room
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const targetBytes = Math.max(1, Math.round(args.target_size_mb * 1024 * 1024))

      let detection
      try {
        detection = (await router.detect(args.input)).detection
      } catch (err) {
        if (err instanceof DetectError) throw new Error(formatFailure(err.error))
        throw err
      }
      const format = detection.format

      // Default output: next to the input, same base + "-min", proper extension.
      const outExt = format === 'mov' ? '.mp4' : canonicalExtension(format)
      const output =
        args.output ??
        path.join(path.dirname(args.input), `${path.basename(args.input, path.extname(args.input))}-min${outExt}`)

      if (path.resolve(output) === path.resolve(args.input)) {
        throw new Error('Output path equals the input path; optimizing would destroy the source. Use the default -min output name or pick another path.')
      }
      if (args.output !== undefined && config.outputRoots.length > 0 && !isInsideRoots(args.output, config.outputRoots)) {
        throw new Error(`Output path is outside every configured outputRoot (${config.outputRoots.join(', ')}).`)
      }
      if (args.overwrite !== true && (await exists(output))) {
        throw new Error(`Output file already exists: ${output}. Pass overwrite: true to replace it.`)
      }

      const overrides: Record<string, string> = {}
      if (config.ffmpegPath) overrides.ffmpegPath = config.ffmpegPath
      if (config.ffprobePath) overrides.ffprobePath = config.ffprobePath
      const resolve = (dep: BinaryDependency): Promise<string | null> => resolveBinary(dep, overrides, logger)

      const result = await optimizeFile(
        args.input, targetBytes, output, format, resolve,
        { logger, signal: exec.signal, timeoutMs: Math.max(config.timeoutMs, 600_000) },
      )
      if (!result.ok) throw new Error(formatFailure(result.error))

      const lines = [
        `Optimized: ${result.input} (${format}) -> ${result.output}`,
        `${formatBytes(result.bytesIn)} -> ${formatBytes(result.bytesOut)} (target ${args.target_size_mb} MB) in ${formatDuration(result.durationMs)}`,
        `Applied: ${result.detail}`,
      ]
      if (result.bytesOut > targetBytes) {
        lines.push(`Warning: result is still above the target; try a higher target_size_mb.`)
      }
      for (const warning of result.warnings) lines.push(`Warning: ${warning}`)
      return lines.join('\n')
    },
  })
}

function isInsideRoots(output: string, roots: string[]): boolean {
  const resolved = path.resolve(output)
  const candidate = process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved
  return roots.some((root) => {
    const rr = path.resolve(root)
    const prefix = process.platform === 'win32' ? rr.replace(/\\/g, '/').toLowerCase() : rr
    return candidate === prefix || candidate.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')
  })
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
