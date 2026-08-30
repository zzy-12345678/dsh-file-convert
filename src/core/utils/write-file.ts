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
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  )
  try {
    await fs.writeFile(tmp, data)
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
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}
