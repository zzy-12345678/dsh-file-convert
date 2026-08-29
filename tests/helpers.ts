import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { PDFDocument } from 'pdf-lib'

export async function tmpDir(prefix = 'dsh-file-convert-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** A PNG whose pixels are fully transparent (alpha 0), red channel 255. */
export async function writeTransparentPng(dir: string, name = 'sample.png', size = { width: 8, height: 8 }): Promise<string> {
  const file = path.join(dir, name)
  await sharp({
    create: {
      width: size.width,
      height: size.height,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toFile(file)
  return file
}

/** An opaque JPEG (solid red). */
export async function writeRedJpg(dir: string, name = 'sample.jpg', size = { width: 8, height: 8 }): Promise<string> {
  const file = path.join(dir, name)
  await sharp({
    create: { width: size.width, height: size.height, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .jpeg({ quality: 90 })
    .toFile(file)
  return file
}

export const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#00ff00"/></svg>`

export async function writeSvg(dir: string, name = 'sample.svg'): Promise<string> {
  const file = path.join(dir, name)
  await fs.writeFile(file, SAMPLE_SVG, 'utf8')
  return file
}

export async function writePdf(dir: string, name = 'sample.pdf', text = 'Hello dsh-file-convert', pages = 1): Promise<string> {
  const pdf = await PDFDocument.create()
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([220, 120])
    page.drawText(text, { x: 20, y: 70, size: 14 })
  }
  const file = path.join(dir, name)
  await fs.writeFile(file, await pdf.save())
  return file
}

export async function writeFile(dir: string, name: string, content: string): Promise<string> {
  const file = path.join(dir, name)
  await fs.writeFile(file, content, 'utf8')
  return file
}
