import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { createRouter } from '../src/core/index.js'
import { tmpDir, writeTransparentPng, writeRedJpg, writeSvg } from './helpers.js'

const router = createRouter()
const NULL_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }

function convert(input: string, outputFormat: string, output?: string) {
  return router.convertFile({ input, outputFormat, output }, { logger: NULL_LOGGER })
}

describe('image conversions', () => {
  it('png -> jpg flattens transparency onto white', async () => {
    const dir = await tmpDir()
    const input = await writeTransparentPng(dir)
    const output = path.join(dir, 'out.jpg')
    const result = await convert(input, 'jpg', output)
    expect(result.ok).toBe(true)

    const meta = await sharp(output).metadata()
    expect(meta.format).toBe('jpeg')
    const { data } = await sharp(output).raw().toBuffer({ resolveWithObject: true })
    // alpha 0 + white flatten -> every pixel (near) white; JPEG may round to 254
    for (let i = 0; i < data.length; i++) expect(data[i]).toBeGreaterThanOrEqual(250)
  })

  it('png -> jpg defaults the output path next to the input', async () => {
    const dir = await tmpDir()
    const input = await writeTransparentPng(dir, 'photo.png')
    const result = await convert(input, 'jpg')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.output).toBe(path.join(dir, 'photo.jpg'))
    await expect(fs.access(path.join(dir, 'photo.jpg'))).resolves.toBeUndefined()
  })

  it('jpg -> png keeps dimensions', async () => {
    const dir = await tmpDir()
    const input = await writeRedJpg(dir, 'in.jpg', { width: 12, height: 7 })
    const output = path.join(dir, 'out.png')
    const result = await convert(input, 'png', output)
    expect(result.ok).toBe(true)
    const meta = await sharp(output).metadata()
    expect(meta.width).toBe(12)
    expect(meta.height).toBe(7)
  })

  it('png -> webp -> png round-trips', async () => {
    const dir = await tmpDir()
    const input = await writeTransparentPng(dir)
    const webp = path.join(dir, 'mid.webp')
    expect((await convert(input, 'webp', webp)).ok).toBe(true)
    const back = path.join(dir, 'back.png')
    const result = await convert(webp, 'png', back)
    expect(result.ok).toBe(true)
    const meta = await sharp(back).metadata()
    expect(meta.format).toBe('png')
    expect(meta.hasAlpha).toBe(true)
  })

  it('svg -> png rasterizes at the svg canvas size', async () => {
    const dir = await tmpDir()
    const input = await writeSvg(dir)
    const output = path.join(dir, 'out.png')
    const result = await convert(input, 'png', output)
    expect(result.ok).toBe(true)
    const meta = await sharp(output).metadata()
    expect(meta.width).toBe(40)
    expect(meta.height).toBe(20)
  })

  it('rejects unsupported targets like png -> pdf', async () => {
    const dir = await tmpDir()
    const input = await writeTransparentPng(dir)
    const result = await convert(input, 'pdf', path.join(dir, 'out.pdf'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('unsupported_conversion')
  })
})
