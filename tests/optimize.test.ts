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
async function writeColorfulImage(dir: string, name: string): Promise<string> {
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
      cells.push(`<rect x="${x * 10}" y="${y * 10}" width="10" height="10" fill="rgb(${r},${g},${b})"/>`)
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 10}" height="${size * 10}">${cells.join('')}</svg>`
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

describeIfFfmpeg('optimize_file (video, needs ffmpeg)', () => {
  it('shrinks an mp4 toward the target with two-pass x264', async () => {
    const dir = await tmpDir()
    const input = path.join(dir, 'clip.mp4')
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
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
