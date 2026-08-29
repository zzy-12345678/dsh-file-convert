import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BinaryDependency, Logger } from '../types.js'

/** Persistent per-user cache for downloaded external binaries. */
export function cacheDir(): string {
  return path.join(os.homedir(), '.dsh-file-convert', 'bin')
}

export function cachedBinaryPath(name: string): string {
  return path.join(cacheDir(), name + (process.platform === 'win32' ? '.exe' : ''))
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Resolution order: explicit config override → system PATH → plugin cache.
 * A later system install therefore naturally takes priority over the cache,
 * while the cache keeps the feature working with zero system changes.
 */
export async function resolveBinaryCached(
  dep: BinaryDependency,
  overrides: Record<string, string | undefined>,
  which: (command: string) => Promise<string | null>,
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
  const cached = cachedBinaryPath(dep.name)
  if (await exists(cached)) {
    logger.debug(`binary ${dep.name}: using cached ${cached}`)
    return cached
  }
  return null
}
