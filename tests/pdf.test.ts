import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { createRouter } from '../src/core/index.js'
import { tmpDir, writePdf } from './helpers.js'

const router = createRouter()
const NULL_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }

async function convert(input: string, outputFormat: string, output: string, dpi?: number) {
  return router.convertFile({ input, outputFormat, output, dpi }, { logger: NULL_LOGGER })
}

describe('pdf conversions', () => {
  it('pdf -> txt extracts text content', async () => {
    const dir = await tmpDir()
    const input = await writePdf(dir)
    const output = path.join(dir, 'out.txt')
    const result = await convert(input, 'txt', output)
    expect(result.ok).toBe(true)
    const text = await fs.readFile(output, 'utf8')
    expect(text).toContain('Hello dsh-file-convert')
  })

  it('pdf -> png writes the exact output path for single-page pdfs', async () => {
    const dir = await tmpDir()
    const input = await writePdf(dir)
    const output = path.join(dir, 'page.png')
    const result = await convert(input, 'png', output)
    expect(result.ok).toBe(true)
    const meta = await sharp(output).metadata()
    expect(meta.format).toBe('png')
    expect(meta.width).toBeGreaterThan(0)
    expect(meta.height).toBeGreaterThan(0)
  })

  it('pdf -> jpg with 2 pages produces numbered outputs', async () => {
    const dir = await tmpDir()
    const input = await writePdf(dir, 'doc.pdf', 'multi page', 2)
    const output = path.join(dir, 'doc.jpg')
    const result = await convert(input, 'jpg', output)
    expect(result.ok).toBe(true)
    await expect(fs.access(path.join(dir, 'doc-1.jpg'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(dir, 'doc-2.jpg'))).resolves.toBeUndefined()
    if (result.ok) {
      expect(result.outputs).toHaveLength(2)
      expect(result.warnings.join(' ')).toMatch(/2 pages/)
    }
  })

  it('honors dpi for rasterization', async () => {
    const dir = await tmpDir()
    const input = await writePdf(dir, 'doc.pdf')
    const low = path.join(dir, 'low.png')
    const high = path.join(dir, 'high.png')
    await convert(input, 'png', low, 72)
    await convert(input, 'png', high, 288)
    const lowMeta = await sharp(low).metadata()
    const highMeta = await sharp(high).metadata()
    expect(highMeta.width!).toBeGreaterThan(lowMeta.width!)
  })
})
