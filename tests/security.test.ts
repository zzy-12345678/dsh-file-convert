import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRouter, realPathBestEffort } from '../src/core/index.js'
import { tmpDir, writeTransparentPng, writePdf } from './helpers.js'

const NULL_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }
const router = createRouter()

/** Windows needs admin/dev-mode for file symlinks (junctions are free). */
async function trySymlink(target: string, link: string, type: 'file' | 'dir'): Promise<boolean> {
  try {
    await fs.symlink(target, link, type)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false
    throw err
  }
}

describe('security hardening', () => {
  it('treats a file symlink to the input as the same file (never destroys the source)', async () => {
    const dir = await tmpDir()
    const input = await writeTransparentPng(dir, 'source.png')
    const alias = path.join(dir, 'alias.png')
    if (!(await trySymlink(input, alias, 'file'))) {
      console.warn('file symlinks unavailable on this machine (no admin/dev mode); skipping')
      return
    }

    const result = await router.convertFile(
      { input: alias, outputFormat: 'jpg', output: input, overwrite: true },
      { logger: NULL_LOGGER },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input')
      expect(result.error.message).toMatch(/destroy the source/)
    }
  })

  it('real-paths symlinks for confinement (directory link covered in limits.test.ts)', async () => {
    const dir = await tmpDir()
    const realFile = path.join(dir, 'real.png')
    await writeTransparentPng(dir, 'real.png')
    const link = path.join(dir, 'link.png')
    if (!(await trySymlink(realFile, link, 'file'))) {
      console.warn('file symlinks unavailable on this machine; skipping')
      return
    }
    expect(await realPathBestEffort(link)).toBe(await realPathBestEffort(realFile))
  })

  it('clamps an oversized SVG to the pixel budget instead of allocating it', async () => {
    const dir = await tmpDir()
    const svg = path.join(dir, 'huge.svg')
    // declares a 20000 x 20000 canvas (400 MP) - far above the 16 MP budget
    await fs.writeFile(
      svg,
      '<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="20000"><rect width="20000" height="20000" fill="#0f0"/></svg>',
      'utf8',
    )
    const output = path.join(dir, 'huge.png')
    const result = await router.convertFile({ input: svg, outputFormat: 'png', output }, { logger: NULL_LOGGER })
    // Either our density clamp fits it into the budget, or libvips' own hard
    // pixel limit rejects the decode cleanly - both are safe outcomes.
    if (result.ok) {
      const sharp = (await import('sharp')).default
      const meta = await sharp(output).metadata()
      expect(meta.width! * meta.height!).toBeLessThanOrEqual(16_000_000)
    } else {
      expect(result.error.code).toBe('conversion_failed')
      expect(`${result.error.message} ${result.error.detail ?? ''}`).toMatch(/pixel/i)
    }
  })

  it('fails a malformed PDF with conversion_failed, not a crash', async () => {
    const dir = await tmpDir()
    const input = path.join(dir, 'broken.pdf')
    // valid magic so detection passes, garbage after
    await fs.writeFile(input, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4096, 0x00)]))
    const result = await router.convertFile({ input, outputFormat: 'txt', output: path.join(dir, 'out.txt') }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('conversion_failed')
  })

  it('fails corrupt media with conversion_failed and reports the decoder', async () => {
    // ffmpeg may legitimately be absent (CI runners stopped shipping it);
    // without it the conversion reads as missing_dependency, which is fine.
    const { resolveBinary, FFMPEG } = await import('../src/core/index.js')
    const ffmpeg = await resolveBinary(FFMPEG, {}, NULL_LOGGER)
    if (!ffmpeg) {
      console.warn('ffmpeg not resolvable on this machine; skipping corrupt-media decode test')
      return
    }
    const dir = await tmpDir()
    const input = path.join(dir, 'fake.mp4')
    // mp4 magic (ftyp) followed by junk - ffmpeg must reject it
    await fs.writeFile(input, Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypmp42'), Buffer.alloc(8192, 0x41)]))
    const result = await router.convertFile({ input, outputFormat: 'mp3', output: path.join(dir, 'fake.mp3') }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('conversion_failed')
  })

  it('survives very long file names without crashing', async () => {
    const dir = await tmpDir()
    const input = await writeTransparentPng(dir, 'x.png')
    const longName = 'y'.repeat(180) + '.jpg'
    const result = await router.convertFile({ input, outputFormat: 'jpg', output: path.join(dir, longName) }, { logger: NULL_LOGGER })
    // either succeeds (long-path aware) or fails cleanly as a conversion error
    if (result.ok) {
      await expect(fs.access(path.join(dir, longName))).resolves.toBeUndefined()
    } else {
      expect(['conversion_failed', 'invalid_input']).toContain(result.error.code)
    }
  })

  it('handles concurrent writes to the same output without corrupting the file', async () => {
    const dir = await tmpDir()
    const inputA = await writeTransparentPng(dir, 'a.png')
    const output = path.join(dir, 'shared.jpg')
    const results = await Promise.all([
      router.convertFile({ input: inputA, outputFormat: 'jpg', output, overwrite: true }, { logger: NULL_LOGGER }),
      router.convertFile({ input: inputA, outputFormat: 'jpg', output, overwrite: true }, { logger: NULL_LOGGER }),
    ])
    expect(results.every((r) => r.ok)).toBe(true)
    // the file must still be a valid JPEG after two concurrent atomic writes
    const sharp = (await import('sharp')).default
    const meta = await sharp(output).metadata()
    expect(meta.format).toBe('jpeg')
  })

  it('optimize refuses an output that symlinks to the input', async () => {
    const dir = await tmpDir()
    const input = await writeTransparentPng(dir, 'src.png')
    const alias = path.join(dir, 'alias.png')
    try {
      await fs.symlink(input, alias, 'file')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        console.warn('file symlinks unavailable on this machine; skipping')
        return
      }
      throw err
    }
    const { createOptimizeFileTool } = await import('../src/tools/optimize-file.js')
    const { createRouter } = await import('../src/core/index.js')
    const config = { quality: 85, dpi: 150, timeoutMs: 60_000, batchMaxFiles: 10, outputRoots: [] }
    const tool = createOptimizeFileTool(createRouter(), config, NULL_LOGGER)
    await expect(
      tool.execute({ input: alias, target_size_mb: 1, output: input, overwrite: true }, { signal: new AbortController().signal } as never),
    ).rejects.toThrow(/destroy the source/)
  })

  it('atomic writes replace content fully and leave no temp leftovers', async () => {
    const dir = await tmpDir()
    const { writeFileAtomic } = await import('../src/core/index.js')
    const file = path.join(dir, 'f.txt')
    await writeFileAtomic(file, 'first')
    await writeFileAtomic(file, 'second-longer-content')
    expect(await fs.readFile(file, 'utf8')).toBe('second-longer-content')
    const leftovers = (await fs.readdir(dir)).filter((n) => n.includes('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('fails huge JSON immediately via the input size limit', async () => {
    const dir = await tmpDir()
    const input = path.join(dir, 'big.json')
    await fs.writeFile(input, JSON.stringify({ pad: 'x'.repeat(300 * 1024) }), 'utf8')
    const small = createRouter({ maxInputBytes: 100 * 1024 })
    const result = await small.convertFile({ input, outputFormat: 'yaml', output: path.join(dir, 'big.yaml') }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_input')
  })
})
