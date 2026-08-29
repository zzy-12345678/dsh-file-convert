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
    const csv = await writeFile(dir, 'data.csv', 'name,age\nAlice,30\n')
    const outcome = await detectFile(csv)
    expect(outcome.detection.format).toBe('csv')
    expect(outcome.detection.confidence).toBe('extension')
  })

  it('sniffs SVG content', async () => {
    const dir = await tmpDir()
    const svg = await writeFile(dir, 'vector.txt', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const outcome = await detectFile(svg)
    expect(outcome.detection.format).toBe('svg')
  })

  it('detects JSON content despite a wrong extension', async () => {
    const dir = await tmpDir()
    const file = await writeFile(dir, 'data.txt', '{"a": 1, "b": [1, 2]}')
    const outcome = await detectFile(file)
    expect(outcome.detection.format).toBe('json')
    expect(outcome.detection.confidence).toBe('magic')
    expect(outcome.warnings.join(' ')).toMatch(/extension suggests txt/i)
  })

  it('detects extension-less JSON', async () => {
    const dir = await tmpDir()
    const file = await writeFile(dir, 'README', '{"a": [1, 2]}')
    const outcome = await detectFile(file)
    expect(outcome.detection.format).toBe('json')
    expect(outcome.detection.confidence).toBe('magic')
  })

  it('does not mistake scalar text for JSON', async () => {
    const dir = await tmpDir()
    const file = await writeFile(dir, 'numbers', '123\n456\n')
    await expect(detectFile(file)).rejects.toBeInstanceOf(DetectError)
  })

  it('guesses YAML from the document marker on extension-less files', async () => {
    const dir = await tmpDir()
    const file = await writeFile(dir, 'config', '---\nkey: value\n')
    const outcome = await detectFile(file)
    expect(outcome.detection.format).toBe('yaml')
    expect(outcome.detection.confidence).toBe('guess')
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
