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

function platformKey(): 'win32' | 'darwin' | 'linux' {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
}

/** Probe results are memoized per (dependency, path) for the process lifetime. */
const probeCache = new Map<string, Promise<boolean>>()

function probeDependency(dep: BinaryDependency, resolved: string): Promise<boolean> {
  if (!dep.probe) return Promise.resolve(true)
  const key = `${dep.name}:${resolved}`
  let pending = probeCache.get(key)
  if (!pending) {
    pending = dep.probe(resolved).catch(() => false)
    probeCache.set(key, pending)
  }
  return pending
}

/**
 * Locate the first existing entry. Patterns may carry `*` in ANY segment
 * (e.g. `C:\Program Files\gs\gs*\bin\gswin64c.exe`); wildcard segments match
 * one path level, preferring the highest-sorted match so newer versions win.
 */
async function firstExisting(paths: string[]): Promise<string | null> {
  for (const candidate of paths) {
    if (!candidate.includes('*')) {
      if (await exists(candidate)) return candidate
      continue
    }
    const expanded = await expandPattern(candidate)
    for (const full of expanded) {
      if (await exists(full)) return full
    }
  }
  return null
}

function wildcardRegex(segment: string): RegExp {
  return new RegExp('^' + segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\\\/:]*') + '$', 'i')
}

/** Expand a path pattern segment by segment; [] when nothing matches. */
export async function expandPattern(pattern: string): Promise<string[]> {
  const absolute = /^[\\/]/.test(pattern)
  const segments = pattern.split(/[\\/]+/).filter((seg, index) => !(index === 0 && seg === ''))
  let current: string[] = [absolute ? path.sep : '']

  for (const seg of segments) {
    if (!seg.includes('*')) {
      current = current.map((prefix) => {
        if (prefix === '') return seg
        // path.join('C:', 'x') drops the drive separator on Windows
        if (/^[A-Za-z]:$/.test(prefix)) return prefix + path.sep + seg
        return path.join(prefix, seg)
      })
      continue
    }
    const regex = wildcardRegex(seg)
    const next: string[] = []
    for (const prefix of current) {
      let entries: string[] = []
      try {
        entries = await fs.readdir(prefix === '' ? '.' : prefix)
      } catch {
        continue
      }
      const matches = entries
        .filter((entry) => regex.test(entry))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      for (const entry of matches) next.push(path.join(prefix, entry))
    }
    if (next.length === 0) return []
    current = next
  }
  return current
}

/**
 * Resolution order: explicit config override → system PATH → known install
 * locations (Windows soffice is rarely on PATH) → plugin cache. Every
 * candidate must pass the dependency's probe when it declares one — a config
 * override pointing at a python without pdf2docx counts as missing.
 */
export async function resolveBinaryCached(
  dep: BinaryDependency,
  overrides: Record<string, string | undefined>,
  which: (command: string) => Promise<string | null>,
  logger: Logger,
): Promise<string | null> {
  const accept = async (resolved: string): Promise<string | null> => {
    if (!(await probeDependency(dep, resolved))) {
      logger.debug(`binary ${dep.name}: ${resolved} resolved but failed its probe`)
      return null
    }
    logger.debug(`binary ${dep.name}: using ${resolved}`)
    return resolved
  }

  const override = dep.configKey ? overrides[dep.configKey] : undefined
  if (override && (await exists(override))) return accept(override)

  for (const command of dep.commands) {
    const found = await which(command)
    if (found) {
      const accepted = await accept(found)
      if (accepted) return accepted
    }
  }

  const located = await firstExisting(dep.extraPaths?.[platformKey()] ?? [])
  if (located) {
    const accepted = await accept(located)
    if (accepted) return accepted
  }

  const cached = cachedBinaryPath(dep.name)
  if (await exists(cached)) {
    const accepted = await accept(cached)
    if (accepted) return accepted
  }
  return null
}
