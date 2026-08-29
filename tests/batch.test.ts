import { describe, expect, it } from 'vitest'
import { createRouter } from '../src/core/index.js'
import type { Config } from '../src/config.js'
import { createBatchConvertTool } from '../src/tools/batch-convert.js'
import { tmpDir, writeFile } from './helpers.js'

const NULL_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }
const SIGNAL = new AbortController().signal

function makeConfig(batchMaxFiles: number): Config {
  return { quality: 85, dpi: 150, timeoutMs: 120_000, batchMaxFiles, outputRoots: [] }
}

describe('batch_convert', () => {
  it('reports truncation instead of silently capping', async () => {
    const dir = await tmpDir()
    for (const name of ['a.json', 'b.json', 'c.json']) {
      await writeFile(dir, name, '[1, 2, 3]')
    }
    const tool = createBatchConvertTool(createRouter(), makeConfig(2), NULL_LOGGER)
    const summary = await tool.execute(
      { input_dir: dir, output_format: 'yaml' } as never,
      { signal: SIGNAL } as never,
    )
    expect(summary).toMatch(/2-file batch limit/)
    expect(summary).toMatch(/not processed/)
    expect(summary).toMatch(/Converted: 2/)
  })

  it('adds no note when everything fits under the limit', async () => {
    const dir = await tmpDir()
    await writeFile(dir, 'a.json', '[1]')
    const tool = createBatchConvertTool(createRouter(), makeConfig(500), NULL_LOGGER)
    const summary = await tool.execute(
      { input_dir: dir, output_format: 'yaml' } as never,
      { signal: SIGNAL } as never,
    )
    expect(summary).toMatch(/Converted: 1/)
    expect(summary).not.toMatch(/Note:/)
  })
})
