import { resolveBinaryCached } from './binaries/cache.js'
import type { BinaryDependency, Logger } from './types.js'

/**
 * Resolve an external binary: plugin config override → system PATH → plugin
 * cache (populated by install_media_dependencies). No auto-install happens
 * here — downloading is an explicit, user-approved tool call.
 */
export async function resolveBinary(
  dep: BinaryDependency,
  overrides: Record<string, string | undefined>,
  logger: Logger,
): Promise<string | null> {
  return resolveBinaryCached(dep, overrides, which, logger)
}

const whichCache = new Map<string, string | null>()

async function which(command: string): Promise<string | null> {
  const cached = whichCache.get(command)
  if (cached !== undefined) return cached
  let result: string | null = null
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await run(cmd, [command], { timeout: 5000 })
    result = stdout.split(/\r?\n/)[0]?.trim() || null
  } catch {
    result = null
  }
  whichCache.set(command, result)
  return result
}
