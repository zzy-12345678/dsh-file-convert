import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRouter, detectFile } from '../src/core/index.js'
import { tmpDir } from './helpers.js'

const run = promisify(execFile)
const NULL_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }

async function hasBinary(command: string): Promise<boolean> {
  try {
    await run(process.platform === 'win32' ? 'where' : 'which', [command])
    return true
  } catch {
    return false
  }
}

const FFMPEG_AVAILABLE = await hasBinary('ffmpeg')
const describeIfFfmpeg = FFMPEG_AVAILABLE ? describe : describe.skip

if (!FFMPEG_AVAILABLE) {
  describe('media conversions (ffmpeg)', () => {
    it('ffmpeg not installed on this machine; media tests run in CI', () => {
      expect(true).toBe(true)
    })
  })
}

describeIfFfmpeg('media conversions (ffmpeg)', () => {
  const router = createRouter()

  async function generate(dir: string, name: string, extraArgs: string[] = []): Promise<string> {
    const file = path.join(dir, name)
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=128x96:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      ...extraArgs,
      '-shortest', file,
    ])
    return file
  }

  it('wav -> mp3 transcodes', async () => {
    const dir = await tmpDir()
    const input = await generate(dir, 'tone.wav', ['-c:a', 'pcm_s16le', '-vn'])
    const output = path.join(dir, 'tone.mp3')
    const result = await router.convertFile({ input, outputFormat: 'mp3', output }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bytesOut).toBeGreaterThan(0)
  })

  it('mp4 -> mp3 extracts audio', async () => {
    const dir = await tmpDir()
    const input = await generate(dir, 'clip.mp4')
    const output = path.join(dir, 'clip.mp3')
    const result = await router.convertFile({ input, outputFormat: 'mp3', output }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(true)
  })

  it('mp4 -> gif rasterizes with a palette', async () => {
    const dir = await tmpDir()
    const input = await generate(dir, 'clip.mp4')
    const output = path.join(dir, 'clip.gif')
    const result = await router.convertFile({ input, outputFormat: 'gif', output }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bytesOut).toBeGreaterThan(0)
  })

  it('mov -> mp4 works via container copy or re-encode', async () => {
    const dir = await tmpDir()
    const input = await generate(dir, 'clip.mov')
    const output = path.join(dir, 'clip.mp4')
    const result = await router.convertFile({ input, outputFormat: 'mp4', output }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(true)
    await expect(fs.access(output)).resolves.toBeUndefined()
  })

  it('detects mp4 by magic bytes and inspects duration', async () => {
    const dir = await tmpDir()
    const input = await generate(dir, 'clip.mp4')
    const outcome = await detectFile(input)
    expect(outcome.detection.format).toBe('mp4')
    expect(outcome.detection.confidence).toBe('magic')

    const info = await router.inspect(input)
    expect(info.kind).toBe('media')
    if (info.kind === 'media') {
      expect(info.durationSec).toBeGreaterThan(0.5)
      expect(info.width).toBe(128)
      expect(info.audioCodec).toBeTruthy()
    }
  })
})
