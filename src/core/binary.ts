import type { BinaryDependency, Logger } from './types.js'

/**
 * V0.1 uses no external binaries, but the resolution hook exists now so
 * V0.2/V0.3 backends (FFmpeg, LibreOffice, Poppler) only fill in data.
 *
 * Resolution order: plugin config override → PATH lookup. No auto-install,
 * ever — the caller surfaces installHint instead.
 */
export async function resolveBinary(
  dep: BinaryDependency,
  overrides: Record<string, string | undefined>,
  logger: Logger,
): Promise<string | null> {
  const override = dep.configKey ? overrides[dep.configKey] : undefined
  if (override) {
    logger.debug(`binary ${dep.name}: using configured path ${override}`)
    return override
  }
  for (const command of dep.commands) {
    const found = await which(command)
    if (found) return found
  }
  return null
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
