import { describe, expect, it } from 'vitest'
import { detectFile, DetectError, parseFormatArg, formatFromExtension } from '../src/core/index.js'
import { tmpDir, writeTransparentPng, writeFile } from './helpers.js'

describe('parseFormatArg', () => {
  it('accepts canonical ids case-insensitively', () => {
    expect(parseFormatArg('png')).toBe('png')
    expect(parseFormatArg('WEBP')).toBe('webp')
  })

  it('resolves aliases and leading dots', () => {
    expect(parseFormatArg('jpeg')).toBe('jpg')
    expect(parseFormatArg('.yml')).toBe('yaml')
    expect(parseFormatArg('YML')).toBe('yaml')
  })

  it('rejects unknown formats', () => {
    expect(parseFormatArg('exe')).toBeNull()
    expect(parseFormatArg('')).toBeNull()
  })
})

describe('formatFromExtension', () => {
  it('maps aliases', () => {
    expect(formatFromExtension('jpeg')).toBe('jpg')
    expect(formatFromExtension('yml')).toBe('yaml')
  })
})

describe('detectFile', () => {
  it('detects binary formats by magic bytes', async () => {
    const dir = await tmpDir()
    const png = await writeTransparentPng(dir, 'photo.jpg') // wrong extension on purpose
    const outcome = await detectFile(png)
    expect(outcome.detection.format).toBe('png')
    expect(outcome.detection.confidence).toBe('magic')
    expect(outcome.warnings.join(' ')).toMatch(/extension suggests jpg/i)
  })

  it('falls back to the extension for text formats', async () => {
    const dir = await tmpDir()
    const json = await writeFile(dir, 'data.json', '{"a":1}')
    const outcome = await detectFile(json)
    expect(outcome.detection.format).toBe('json')
    expect(outcome.detection.confidence).toBe('extension')
  })

  it('sniffs SVG content', async () => {
    const dir = await tmpDir()
    const svg = await writeFile(dir, 'vector.txt', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const outcome = await detectFile(svg)
    expect(outcome.detection.format).toBe('svg')
  })

  it('fails with unknown_format for unrecognized files', async () => {
    const dir = await tmpDir()
    const mystery = await writeFile(dir, 'blob.xyz', '\x00\x01\x02not a known format')
    await expect(detectFile(mystery)).rejects.toBeInstanceOf(DetectError)
  })

  it('fails with input_not_found for missing files', async () => {
    await expect(detectFile('Z:/definitely/missing.png')).rejects.toBeInstanceOf(DetectError)
  })
})
