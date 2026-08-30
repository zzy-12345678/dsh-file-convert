import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { createRouter, detectFile, optimizeFile } from '../src/core/index.js'
import { tmpDir } from './helpers.js'

const run = promisify(execFile)
const NULL_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }
const SILENT_RESOLVE = async () => null

/** A colorful, hard-to-compress image so encoder quality actually matters. */
async function writeColorfulImage(dir: string, name: string, cellPx = 10): Promise<string> {
  const size = 24
  const cells: string[] = []
  let seed = 42
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.floor(rand() * 256)
      const g = Math.floor(rand() * 256)
      const b = Math.floor(rand() * 256)
      cells.push(`<rect x="${x * cellPx}" y="${y * cellPx}" width="${cellPx}" height="${cellPx}" fill="rgb(${r},${g},${b})"/>`)
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size * cellPx}" height="${size * cellPx}">${cells.join('')}</svg>`
  const file = path.join(dir, name)
  const pipeline = sharp(Buffer.from(svg))
  if (name.endsWith('.jpg')) await pipeline.jpeg({ quality: 95 }).toFile(file)
  else if (name.endsWith('.webp')) await pipeline.webp({ quality: 95 }).toFile(file)
  else await pipeline.png().toFile(file)
  return file
}

async function hasBinary(command: string): Promise<boolean> {
  try {
    await run(process.platform === 'win32' ? 'where' : 'which', [command])
    return true
  } catch {
    return false
  }
}

const FFMPEG_AVAILABLE = await hasBinary('ffmpeg')
const GS_COMMAND = process.platform === 'win32' ? 'gswin64c' : 'gs'
const GS_AVAILABLE = (await hasBinary(GS_COMMAND)) || (await hasBinary('gs'))

describe('optimize_file (images, no external tools)', () => {
  it('shrinks a jpg below the target via quality search', async () => {
    const dir = await tmpDir()
    const input = await writeColorfulImage(dir, 'photo.jpg')
    const bytesIn = (await fs.stat(input)).size
    const targetBytes = Math.floor(bytesIn * 0.4)

    const result = await optimizeFile(input, targetBytes, path.join(dir, 'photo-min.jpg'), 'jpg', SILENT_RESOLVE, { logger: NULL_LOGGER, timeoutMs: 30_000 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.bytesOut).toBeLessThanOrEqual(targetBytes)
      expect(result.bytesOut).toBeGreaterThan(0)
      expect(result.detail).toMatch(/quality \d+/)
    }
  })

  it('shrinks a webp below the target', async () => {
    const dir = await tmpDir()
    const input = await writeColorfulImage(dir, 'photo.webp')
    const bytesIn = (await fs.stat(input)).size
    const targetBytes = Math.floor(bytesIn * 0.5)

    const result = await optimizeFile(input, targetBytes, path.join(dir, 'photo-min.webp'), 'webp', SILENT_RESOLVE, { logger: NULL_LOGGER, timeoutMs: 30_000 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bytesOut).toBeLessThanOrEqual(targetBytes)
  })

  it('optimizes png through palette reduction with a warning', async () => {
    const dir = await tmpDir()
    const input = await writeColorfulImage(dir, 'photo.png')
    const bytesIn = (await fs.stat(input)).size
    const targetBytes = Math.floor(bytesIn * 0.6)

    const result = await optimizeFile(input, targetBytes, path.join(dir, 'photo-min.png'), 'png', SILENT_RESOLVE, { logger: NULL_LOGGER, timeoutMs: 30_000 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings.length).toBeGreaterThan(0)
      expect(result.bytesOut).toBeLessThanOrEqual(targetBytes)
    }
  })

  it('rejects formats it cannot optimize', async () => {
    const dir = await tmpDir()
    const input = await writeColorfulImage(dir, 'anim.gif')
    const result = await optimizeFile(input, 1024, path.join(dir, 'anim-min.gif'), 'gif', SILENT_RESOLVE, { logger: NULL_LOGGER, timeoutMs: 30_000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('unsupported_conversion')
  })

  it('routes detect -> optimize for a jpg end to end', async () => {
    const dir = await tmpDir()
    const input = await writeColorfulImage(dir, 'e2e.jpg')
    const { detection } = await detectFile(input)
    expect(detection.format).toBe('jpg')
    const targetBytes = Math.floor((await fs.stat(input)).size * 0.4)
    const result = await optimizeFile(input, targetBytes, path.join(dir, 'e2e-min.jpg'), detection.format, SILENT_RESOLVE, { logger: NULL_LOGGER, timeoutMs: 30_000 })
    expect(result.ok).toBe(true)
  })
})

const describeIfFfmpeg = FFMPEG_AVAILABLE ? describe : describe.skip

const describeIfGs = GS_AVAILABLE ? describe : describe.skip

describeIfGs('optimize_file (pdf, needs ghostscript)', () => {
  it('shrinks an image-heavy pdf below the target', async () => {
    const dir = await tmpDir()
    // 720x720 px on a 240x240 pt page = 216 dpi effective, so Ghostscript's
    // /ebook (150 dpi) preset actually downsamples the image.
    const jpgPath = await writeColorfulImage(dir, 'photo.jpg', 30)
    const { PDFDocument } = await import('pdf-lib')
    const pdf = await PDFDocument.create()
    // embedJpg expects the JPEG bytes (a path string would be read as base64)
    const image = await pdf.embedJpg(await fs.readFile(jpgPath))
    const page = pdf.addPage([240, 240])
    page.drawImage(image, { x: 0, y: 0, width: 240, height: 240 })
    const input = path.join(dir, 'doc.pdf')
    await fs.writeFile(input, await pdf.save())

    const bytesIn = (await fs.stat(input)).size
    const targetBytes = Math.floor(bytesIn * 0.7)
    // gs resolves by command name on the platforms that ship it
    const realResolve = async () => GS_COMMAND

    const result = await optimizeFile(input, targetBytes, path.join(dir, 'doc-min.pdf'), 'pdf', realResolve, {
      logger: NULL_LOGGER,
      timeoutMs: 120_000,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bytesOut).toBeLessThanOrEqual(targetBytes)
  })
})

describeIfFfmpeg('optimize_file (video, needs ffmpeg)', () => {
  it('shrinks an mp4 toward the target with two-pass x264', async () => {
    const dir = await tmpDir()
    const input = path.join(dir, 'clip.mp4')
    // 15s at 640x480: big enough that a 50% target sits above the two-pass
    // minimum bitrate floor (tiny fixtures get refused by design).
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=duration=15:size=640x480:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=15',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', input,
    ])
    const bytesIn = (await fs.stat(input)).size
    const targetBytes = Math.floor(bytesIn * 0.5)
    // ffmpeg/ffprobe are on PATH here; resolve by command name.
    const realResolve = async (dep: { name: string }) => dep.name

    const result = await optimizeFile(input, targetBytes, path.join(dir, 'clip-min.mp4'), 'mp4', realResolve, { logger: NULL_LOGGER, timeoutMs: 120_000 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.bytesOut).toBeLessThanOrEqual(Math.floor(targetBytes * 1.15))
      expect(result.detail).toMatch(/two-pass x264/)
    }
  })
})
