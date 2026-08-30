import fs from 'node:fs/promises'
import path from 'node:path'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import { describe, expect, it } from 'vitest'
import { createRouter, resolveBinary, SOFFICE, PYTHON_PDF2DOCX } from '../src/core/index.js'
import { tmpDir, writePdf } from './helpers.js'

const NULL_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }
const router = createRouter()

const soffice = await resolveBinary(SOFFICE, {}, NULL_LOGGER)
const pdf2docx = await resolveBinary(PYTHON_PDF2DOCX, {}, NULL_LOGGER)

const describeIfSoffice = soffice ? describe : describe.skip
const describeIfPdf2docx = pdf2docx ? describe : describe.skip

async function writeDocx(dir: string, name = 'letter.docx'): Promise<string> {
  const doc = new Document({
    sections: [{ children: [new Paragraph({ children: [new TextRun('Hello dsh-file-convert')] })] }],
  })
  const file = path.join(dir, name)
  await fs.writeFile(file, await Packer.toBuffer(doc))
  return file
}

describeIfSoffice('office conversions (LibreOffice)', () => {
  it('docx -> pdf renders a real PDF', async () => {
    const dir = await tmpDir()
    const input = await writeDocx(dir)
    const output = path.join(dir, 'letter.pdf')

    const result = await router.convertFile({ input, outputFormat: 'pdf', output }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.bytesOut).toBeGreaterThan(0)
      const head = await fs.readFile(output).then((b) => b.subarray(0, 5).toString())
      expect(head).toBe('%PDF-')
    }
  })

  it('runs against an isolated profile and serializes (concurrency 1)', async () => {
    const office = router.route('docx', 'pdf')
    expect(office).toBeTruthy()
    expect(office!.concurrency).toBe(1)
  })
})

describeIfPdf2docx('pdf -> docx (experimental, python pdf2docx)', () => {
  it('converts a text pdf into a docx that contains the source text', async () => {
    const dir = await tmpDir()
    const input = await writePdf(dir) // draws "Hello dsh-file-convert"
    const output = path.join(dir, 'out.docx')

    const result = await router.convertFile({ input, outputFormat: 'docx', output }, { logger: NULL_LOGGER })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.bytesOut).toBeGreaterThan(0)
    expect(result.warnings.join(' ')).toMatch(/experimental/i)

    // The conversion must carry the text over, not just produce a file.
    const { unzipSync } = await import('fflate')
    const docx = unzipSync(await fs.readFile(output))
    const documentXml = Buffer.from(docx['word/document.xml']).toString('utf8')
    expect(documentXml).toContain('Hello dsh-file-convert')
  })
})
