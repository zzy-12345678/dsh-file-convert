import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRouter } from '../src/core/index.js'
import { tmpDir, writePdf } from './helpers.js'

/**
 * Gated: set DSH_TEST_TESSERACT to a tesseract binary path with an `eng`
 * language pack, e.g. DSH_TEST_TESSERACT="D:\tesseract\tesseract.exe".
 * Without it the suite is skipped (CI has no tesseract; the bundled
 * tesseract.js fallback would download language data).
 */
const tesseractPath = process.env.DSH_TEST_TESSERACT
const describeIfTesseract = tesseractPath ? describe : describe.skip
const NULL_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }

describeIfTesseract('ocr (pdf -> txt via local tesseract)', () => {
  const router = createRouter({ binaryOverrides: { tesseractPath } })

  it('recognizes rendered text with the CLI engine', async () => {
    const dir = await tmpDir()
    const input = await writePdf(dir, 'scan.pdf', 'Hello dsh-file-convert OCR check', 1)
    const output = path.join(dir, 'out.txt')

    const result = await router.convertFile(
      { input, outputFormat: 'txt', output, ocr: true, ocrLang: 'eng', dpi: 300 },
      { logger: NULL_LOGGER },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      const text = await fs.readFile(output, 'utf8')
      expect(text).toMatch(/Hello/i)
      expect(result.warnings.join(' ')).toMatch(/OCR via tesseract-cli/)
    }
  })

  it('warns when a text layer exists but OCR is forced', async () => {
    const dir = await tmpDir()
    const input = await writePdf(dir, 'text-layer.pdf', 'Visible text layer content', 1)
    const output = path.join(dir, 'out.txt')

    const result = await router.convertFile(
      { input, outputFormat: 'txt', output, ocr: true, ocrLang: 'eng', dpi: 300 },
      { logger: NULL_LOGGER },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings.join(' ')).toMatch(/text layer was detected/i)
  })
})
