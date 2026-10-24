import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Write `data` to `target` atomically: the bytes land in a sibling temp file
 * (same volume, so rename never hits EXDEV) and are renamed over the target
 * only when complete. Windows AV scanners can hold the target briefly - those
 * lock errors are retried a few times; a persistent failure throws loudly
 * rather than degrading to a non-atomic copy.
 */
export async function writeFileAtomic(target: string, data: Buffer | string): Promise<void> {
  const tmp = siblingTemp(target)
  try {
    await fs.writeFile(tmp, data)
    await renameWithRetry(tmp, target)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/**
 * Publish a completed scratch file to its final location atomically. A
 * same-volume rename happens in place; across volumes the bytes are copied to
 * a sibling temp of the target first, so the target only ever sees a complete
 * file even if the copy or the process dies halfway.
 */
export async function publishFileAtomic(source: string, target: string): Promise<void> {
  try {
    await renameWithRetry(source, target)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
  }
  const tmp = siblingTemp(target)
  try {
    await fs.copyFile(source, tmp)
    await renameWithRetry(tmp, target)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

function siblingTemp(target: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  )
}

async function renameWithRetry(tmp: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, target)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 2 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw err
      await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)))
    }
  }
}
