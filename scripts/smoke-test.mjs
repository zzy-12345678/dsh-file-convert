/**
 * End-to-end smoke test against the built lib/ output (no vitest, no TS).
 * Usage: npm run build && npm run smoke
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import sharp from 'sharp'
import { createRouter } from '../lib/core/index.js'

const NULL_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-file-convert-smoke-'))
const router = createRouter()

async function expectOk(req) {
  const result = await router.convertFile(req, { logger: NULL_LOGGER })
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`)
  return result
}

// data chain: json -> yaml -> csv
const jsonFile = path.join(dir, 'smoke.json')
await fs.writeFile(jsonFile, JSON.stringify([{ id: 1, name: 'one' }, { id: 2, name: 'two' }]), 'utf8')
const yamlFile = path.join(dir, 'smoke.yaml')
await expectOk({ input: jsonFile, outputFormat: 'yaml', output: yamlFile })
const csvFile = path.join(dir, 'smoke.csv')
await expectOk({ input: yamlFile, outputFormat: 'csv', output: csvFile })
const csvText = await fs.readFile(csvFile, 'utf8')
if (!csvText.includes('one') || !csvText.includes('two')) throw new Error('csv output unexpected')

// image chain: png -> webp -> jpg
const pngFile = path.join(dir, 'smoke.png')
await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 10, g: 200, b: 30, alpha: 0.5 } } })
  .png()
  .toFile(pngFile)
const webpFile = path.join(dir, 'smoke.webp')
await expectOk({ input: pngFile, outputFormat: 'webp', output: webpFile })
const jpgFile = path.join(dir, 'smoke.jpg')
await expectOk({ input: webpFile, outputFormat: 'jpg', output: jpgFile })

// pdf -> txt
const { PDFDocument } = await import('pdf-lib')
const pdf = await PDFDocument.create()
const page = pdf.addPage([200, 100])
page.drawText('dsh-file-convert smoke', { x: 20, y: 60, size: 14 })
const pdfFile = path.join(dir, 'smoke.pdf')
await fs.writeFile(pdfFile, await pdf.save())
const txtFile = path.join(dir, 'smoke.txt')
await expectOk({ input: pdfFile, outputFormat: 'txt', output: txtFile })
const txt = await fs.readFile(txtFile, 'utf8')
if (!txt.includes('dsh-file-convert smoke')) throw new Error('txt output unexpected')

const statuses = await router.listConversions()
if (statuses.length !== 22) throw new Error(`expected 22 capabilities, got ${statuses.length}`)

// media: only exercised when ffmpeg is on PATH; otherwise the matrix must report it missing
const hasFfmpeg = await new Promise((resolve) => {
  const probe = execFile(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], (err) => resolve(!err))
  probe.on('error', () => resolve(false))
})
let mediaNote = 'ffmpeg not on PATH: media rows correctly reported unavailable'
if (hasFfmpeg) {
  const wavFile = path.join(dir, 'smoke.wav')
  const run = (args) =>
    new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], (err) => (err ? reject(err) : resolve()))
    })
  await run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:a', 'pcm_s16le', '-vn', wavFile])
  const mp3File = path.join(dir, 'smoke.mp3')
  await expectOk({ input: wavFile, outputFormat: 'mp3', output: mp3File })
  const unavailable = statuses.filter((s) => !s.available)
  if (unavailable.length !== 0) throw new Error(`expected no unavailable rows with ffmpeg installed, got: ${unavailable.map((u) => u.from + '->' + u.to)}`)
  mediaNote = 'wav -> mp3 verified with local ffmpeg'
} else {
  const mediaRows = statuses.filter((s) => ['mp4', 'mov', 'wav'].includes(s.from))
  if (!mediaRows.every((s) => !s.available)) throw new Error('media rows should be unavailable without ffmpeg')
}

console.log(`smoke OK: capability matrix (${statuses.length}), ${mediaNote} - in ${dir}`)
