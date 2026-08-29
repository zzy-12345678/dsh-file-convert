import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRouter } from '../src/core/index.js'
import { tmpDir, writeTransparentPng, writeRedJpg } from './helpers.js'

const router = createRouter()
const NULL_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }

describe('router pipeline', () => {
  it('reports input_not_found for missing files', async () => {
    const result = await router.convertFile(
      { input: 'Z:/missing/file.png', outputFormat: 'jpg' },
      { logger: NULL_LOGGER },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('input_not_found')
  })

  it('reports unknown output formats with the supported list', async () => {
    const dir = await tmpDir()
    const input = await writeTransparentPng(dir)
    const result = await router.convertFile({ input, outputFormat: 'docx' }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('unsupported_conversion')
      expect(result.error.hint).toContain('Supported formats')
    }
  })

  it('rejects identity conversions', async () => {
    const dir = await tmpDir()
    const input = await writeTransparentPng(dir)
    const result = await router.convertFile({ input, outputFormat: 'png' }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('unsupported_conversion')
  })

  it('enforces overwrite policy', async () => {
    const dir = await tmpDir()
    const input = await writeTransparentPng(dir, 'a.png')
    const output = path.join(dir, 'a.jpg')
    await router.convertFile({ input, outputFormat: 'jpg', output }, { logger: NULL_LOGGER })
    const firstSize = (await fs.stat(output)).size

    const blocked = await router.convertFile({ input, outputFormat: 'jpg', output }, { logger: NULL_LOGGER })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error.code).toBe('output_exists')

    const replaced = await router.convertFile({ input, outputFormat: 'jpg', output, overwrite: true }, { logger: NULL_LOGGER })
    expect(replaced.ok).toBe(true)
  })

  it('listConversions covers the V0.1 matrix with no missing deps', async () => {
    const statuses = await router.listConversions()
    expect(statuses.length).toBe(18)
    expect(statuses.every((s) => s.available)).toBe(true)
    const pdf = statuses.filter((s) => s.from === 'pdf').map((s) => s.to)
    expect(pdf).toEqual(['jpg', 'png', 'txt'])
  })

  it('inspect returns image facts and data record counts', async () => {
    const dir = await tmpDir()
    const jpg = await writeRedJpg(dir, 'photo.jpg', { width: 12, height: 7 })
    const image = await router.inspect(jpg)
    expect(image).toMatchObject({ kind: 'image', format: 'jpg', width: 12, height: 7 })

    const json = path.join(dir, 'data.json')
    await fs.writeFile(json, '[1,2,3]', 'utf8')
    const data = await router.inspect(json)
    expect(data).toMatchObject({ kind: 'data', format: 'json', records: 3 })
  })

  it('createRouter produces a usable router with all three converters', async () => {
    const dir = await tmpDir()
    const statuses = await router.listConversions()
    const ids = new Set(statuses.map((s) => s.from))
    expect(ids.has('pdf')).toBe(true)
    expect(ids.has('png')).toBe(true)
    expect(ids.has('json')).toBe(true)
    expect(path.basename(dir)).toMatch(/^dsh-file-convert-/)
  })
})
