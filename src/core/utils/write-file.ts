import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Write `data` to `target` atomically: the bytes land in a sibling temp file
 * first and are renamed into place only when complete, so an interrupted run
 * never leaves a half-written output behind.
 */
export async function writeFileAtomic(target: string, data: Buffer | string): Promise<void> {
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  )
  try {
    await fs.writeFile(tmp, data)
    try {
      await fs.rename(tmp, target)
    } catch {
      // cross-device or platform quirk: fall back to a full copy
      await fs.copyFile(tmp, target)
      await fs.rm(tmp, { force: true })
    }
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}
