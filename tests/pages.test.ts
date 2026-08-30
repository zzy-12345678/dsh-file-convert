import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRouter, parsePageRange, PageRangeError } from '../src/core/index.js'
import { tmpDir, writePdf } from './helpers.js'

const router = createRouter()
const NULL_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }

describe('parsePageRange', () => {
  it('parses single pages, ranges and combinations, deduplicated and sorted', () => {
    expect(parsePageRange('5', 10)).toEqual([5])
    expect(parsePageRange('1-3,5', 10)).toEqual([1, 2, 3, 5])
    expect(parsePageRange('2,1-3', 10)).toEqual([1, 2, 3])
    expect(parsePageRange('8-10,3', 10)).toEqual([3, 8, 9, 10])
  })

  it('rejects malformed and out-of-range selections', () => {
    expect(() => parsePageRange('abc', 10)).toThrow(PageRangeError)
    expect(() => parsePageRange('', 10)).toThrow(PageRangeError)
    expect(() => parsePageRange('4-2', 10)).toThrow(PageRangeError)
    expect(() => parsePageRange('0', 10)).toThrow(PageRangeError)
    expect(() => parsePageRange('11', 10)).toThrow(PageRangeError)
    try {
      parsePageRange('99', 10)
    } catch (err) {
      expect((err as PageRangeError).error.code).toBe('invalid_input')
      expect((err as PageRangeError).error.message).toContain('has 10 page(s)')
    }
  })
})

describe('pdf conversions with pages option', () => {
  it('rasterizes only the selected pages, named after the real page numbers', async () => {
    const dir = await tmpDir()
    const input = await writePdf(dir, 'doc.pdf', 'page text', 3)
    const output = path.join(dir, 'doc.png')

    const result = await router.convertFile({ input, outputFormat: 'png', output, pages: '1,3' }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(true)
    await expect(fs.access(path.join(dir, 'doc-1.png'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(dir, 'doc-3.png'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(dir, 'doc-2.png'))).rejects.toThrow()
    if (result.ok) {
      expect(result.outputs).toHaveLength(2)
      expect(result.warnings.join(' ')).toMatch(/page\(s\) 1, 3 of 3/)
    }
  })

  it('writes exactly the output path when one page is selected', async () => {
    const dir = await tmpDir()
    const input = await writePdf(dir, 'doc.pdf', 'page text', 3)
    const output = path.join(dir, 'single.png')
    const result = await router.convertFile({ input, outputFormat: 'png', output, pages: '2' }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(true)
    await expect(fs.access(output)).resolves.toBeUndefined()
    await expect(fs.access(path.join(dir, 'doc-1.png'))).rejects.toThrow()
  })

  it('extracts text from the selected pages only', async () => {
    const dir = await tmpDir()
    const input = await writePdf(dir, 'doc.pdf', 'marker', 3, ['alpha one', 'beta two', 'gamma three'])
    const output = path.join(dir, 'out.txt')

    const result = await router.convertFile({ input, outputFormat: 'txt', output, pages: '2' }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(true)
    const text = await fs.readFile(output, 'utf8')
    expect(text).toContain('beta two')
    expect(text).not.toContain('alpha one')
    expect(text).not.toContain('gamma three')
  })

  it('fails with a page-range error for out-of-bounds selections', async () => {
    const dir = await tmpDir()
    const input = await writePdf(dir, 'doc.pdf', 'page text', 3)
    const result = await router.convertFile({ input, outputFormat: 'png', output: path.join(dir, 'x.png'), pages: '2,99' }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input')
      expect(result.error.message).toContain('has 3 page(s)')
    }
  })
})
