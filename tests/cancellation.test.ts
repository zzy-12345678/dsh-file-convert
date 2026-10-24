import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeFileAtomic, publishFileAtomic } from '../src/core/utils/write-file.js'
import { createRouter, optimizeFile } from '../src/core/index.js'
import type { BinaryDependency, Logger } from '../src/core/types.js'
import { tmpDir, writeRedJpg, writePdf, writeFile } from './helpers.js'

const NULL_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} }
const SILENT_RESOLVE = async (_dep: BinaryDependency): Promise<string | null> => null

function abortedSignal(): AbortSignal {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

async function noTempFilesLeft(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir)
  return entries.every((entry) => !entry.endsWith('.tmp'))
}

describe('atomic final-path writes', () => {
  it('writeFileAtomic replaces the target and leaves no temp files', async () => {
    const dir = await tmpDir()
    const target = path.join(dir, 'out.txt')
    await fs.writeFile(target, 'stale', 'utf8')
    await writeFileAtomic(target, 'fresh')
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('fresh')
    expect(await noTempFilesLeft(dir)).toBe(true)
  })

  it('publishFileAtomic renames a same-directory scratch file over the target', async () => {
    const dir = await tmpDir()
    const target = path.join(dir, 'out.bin')
    await fs.writeFile(target, 'old-bytes')
    const scratch = path.join(dir, '.out.bin.scratch')
    await fs.writeFile(scratch, 'new-bytes')
    await publishFileAtomic(scratch, target)
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('new-bytes')
    await expect(fs.access(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await noTempFilesLeft(dir)).toBe(true)
  })

  it('publishFileAtomic moves a scratch file from another directory (EXDEV-safe publish)', async () => {
    const dir = await tmpDir()
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-publish-src-'))
    const target = path.join(dir, 'out.bin')
    const scratch = path.join(other, 'candidate')
    await fs.writeFile(scratch, 'candidate-bytes')
    await publishFileAtomic(scratch, target)
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('candidate-bytes')
    await expect(fs.access(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('a completed conversion leaves no hidden temp files in the output directory', async () => {
    const dir = await tmpDir()
    const router = createRouter()
    const input = await writeRedJpg(dir, 'photo.jpg')
    const result = await router.convertFile({ input, outputFormat: 'png' }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(true)
    expect(await noTempFilesLeft(dir)).toBe(true)
  })
})

describe('cooperative cancellation', () => {
  it('convert_file with an already-aborted signal cancels without writing output (image)', async () => {
    const dir = await tmpDir()
    const router = createRouter()
    const input = await writeRedJpg(dir)
    const output = path.join(dir, 'out.png')
    const result = await router.convertFile(
      { input, outputFormat: 'png', output },
      { logger: NULL_LOGGER, signal: abortedSignal() },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('cancelled')
    await expect(fs.access(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('convert_file with an already-aborted signal cancels without writing output (data)', async () => {
    const dir = await tmpDir()
    const router = createRouter()
    const input = await writeFile(dir, 'data.json', '{"a": 1}')
    const output = path.join(dir, 'data.yaml')
    const result = await router.convertFile(
      { input, outputFormat: 'yaml', output },
      { logger: NULL_LOGGER, signal: abortedSignal() },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('cancelled')
    await expect(fs.access(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('convert_file with an already-aborted signal cancels before the first PDF page', async () => {
    const dir = await tmpDir()
    const router = createRouter()
    const input = await writePdf(dir, 'doc.pdf', 'page one', 2)
    const output = path.join(dir, 'doc.png')
    const result = await router.convertFile(
      { input, outputFormat: 'png', output },
      { logger: NULL_LOGGER, signal: abortedSignal() },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('cancelled')
    await expect(fs.access(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('optimize_file with an already-aborted signal cancels without writing output', async () => {
    const dir = await tmpDir()
    const input = await writeRedJpg(dir, 'big.jpg', { width: 64, height: 64 })
    const output = path.join(dir, 'big-min.jpg')
    const result = await optimizeFile(input, 256, output, 'jpg', SILENT_RESOLVE, {
      logger: NULL_LOGGER,
      timeoutMs: 30_000,
      signal: abortedSignal(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('cancelled')
    await expect(fs.access(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('an abort between optimizer probes stops the binary search and writes nothing', async () => {
    const dir = await tmpDir()
    const input = await writeRedJpg(dir, 'mid.jpg', { width: 512, height: 512 })
    const output = path.join(dir, 'mid-min.jpg')

    // Floor probe must fit so the binary search actually runs; pick the
    // target as the exact size of the lowest-quality encode.
    const floor = await (await import('sharp')).default(input).jpeg({ quality: 5 }).toBuffer()

    // A signal that reports aborted from its second read: the first read is
    // the loop guard of binary-search iteration 1, so iteration 2 must abort
    // before writing anything.
    let reads = 0
    const signal = {
      get aborted() {
        return ++reads > 1
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal

    const result = await optimizeFile(input, floor.length, output, 'jpg', SILENT_RESOLVE, {
      logger: NULL_LOGGER,
      timeoutMs: 30_000,
      signal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('cancelled')
    await expect(fs.access(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
