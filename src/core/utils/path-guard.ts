import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * realpath the deepest EXISTING ancestor of a path and rejoin the remainder:
 * symlinks anywhere in the existing part are resolved, which is what output
 * confinement and same-file checks need (a symlink inside a root can point
 * outside, and two different-looking paths can be the same file).
 */
export async function realPathBestEffort(p: string): Promise<string> {
  let current = path.resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...tail.reverse())
    } catch {
      /* segment does not exist yet - walk up */
    }
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(p)
    tail.push(path.basename(current))
    current = parent
  }
}

/** Same file on disk, comparing real paths (symlink/case/separator aware). */
export async function isSameFile(a: string, b: string): Promise<boolean> {
  const ra = await realPathBestEffort(a)
  const rb = await realPathBestEffort(b)
  if (ra === rb) return true
  // Windows paths are case-insensitive; also fold / vs \.
  return process.platform === 'win32' && ra.replace(/\\/g, '/').toLowerCase() === rb.replace(/\\/g, '/').toLowerCase()
}

function normalizeForCompare(p: string): string {
  return process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p
}

/** True when `candidate` is `root` itself or lives inside it (real paths). */
export async function isInsideRoot(candidate: string, root: string): Promise<boolean> {
  const realCandidate = normalizeForCompare(await realPathBestEffort(candidate))
  const realRoot = normalizeForCompare(await realPathBestEffort(path.resolve(root)))
  return realCandidate === realRoot || realCandidate.startsWith(realRoot.endsWith('/') ? realRoot : realRoot + '/')
}

/** True when the candidate is inside at least one of the roots. */
export async function isInsideAnyRoot(candidate: string, roots: string[] | undefined): Promise<boolean> {
  if (!roots || roots.length === 0) return true
  for (const root of roots) {
    if (await isInsideRoot(candidate, root)) return true
  }
  return false
}
