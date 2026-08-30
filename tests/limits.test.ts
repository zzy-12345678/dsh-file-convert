import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRouter, type RouterDefaults } from '../src/core/index.js'
import { tmpDir, writeTransparentPng, writePdf } from './helpers.js'

const NULL_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }

function routerWith(overrides: Partial<RouterDefaults>) {
  return createRouter(overrides)
}

describe('resource limits', () => {
  it('refuses inputs above maxInputBytes', async () => {
    const dir = await tmpDir()
    const input = await writeTransparentPng(dir) // > 10 bytes
    const router = routerWith({ maxInputBytes: 10 })
    const result = await router.convertFile({ input, outputFormat: 'jpg' }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input')
      expect(result.error.hint).toContain('maxInputMb')
    }
  })

  it('refuses full-document rasterization above maxPdfPages, allows explicit selection', async () => {
    const dir = await tmpDir()
    const input = await writePdf(dir, 'doc.pdf', 'page text', 3)
    const router = routerWith({ maxPdfPages: 2 })

    const blocked = await router.convertFile({ input, outputFormat: 'png', output: path.join(dir, 'all.png') }, { logger: NULL_LOGGER })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error.message).toContain('3 pages')

    const selected = await router.convertFile(
      { input, outputFormat: 'png', output: path.join(dir, 'one.png'), pages: '1' },
      { logger: NULL_LOGGER },
    )
    expect(selected.ok).toBe(true)
  })

  it('clamps rasterized pixels to maxOutputPixels', async () => {
    const dir = await tmpDir()
    const input = await writePdf(dir, 'doc.pdf', 'big', 1) // 220x120 pt page
    const router = routerWith({ maxOutputPixels: 250_000 })
    const output = path.join(dir, 'clamped.png')
    const sharp = (await import('sharp')).default

    const result = await router.convertFile({ input, outputFormat: 'png', output, dpi: 600 }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings.join(' ')).toMatch(/pixel budget/)
      const meta = await sharp(output).metadata()
      expect(meta.width! * meta.height!).toBeLessThanOrEqual(250_000)
    }
  })
})

describe('outputRoots symlink resolution', () => {
  it('rejects outputs that escape a root through a symlink', async () => {
    const dir = await tmpDir()
    const root = path.join(dir, 'root')
    const outside = path.join(dir, 'outside')
    await fs.mkdir(root, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    const link = path.join(root, 'link')
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')

    const router = routerWith({ outputRoots: [root] })
    const input = await writeTransparentPng(dir, 'x.png')

    const throughLink = await router.convertFile(
      { input, outputFormat: 'jpg', output: path.join(link, 'escape.jpg') },
      { logger: NULL_LOGGER },
    )
    expect(throughLink.ok).toBe(false)
    if (!throughLink.ok) expect(throughLink.error.code).toBe('invalid_input')

    const direct = await router.convertFile(
      { input, outputFormat: 'webp', output: path.join(root, 'fine.webp') },
      { logger: NULL_LOGGER },
    )
    expect(direct.ok).toBe(true)
  })
})
