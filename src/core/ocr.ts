import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execTool } from './utils/exec.js'
import { cacheDir } from './binaries/cache.js'
import type { BinaryDependency, ConvertContext, Logger } from './types.js'

export const TESSERACT: BinaryDependency = {
  name: 'tesseract',
  displayName: 'Tesseract OCR',
  commands: ['tesseract'],
  configKey: 'tesseractPath',
  extraPaths: {
    win32: ['C:\\Program Files\\Tesseract-OCR\\tesseract.exe'],
    darwin: ['/opt/homebrew/bin/tesseract', '/usr/local/bin/tesseract'],
    linux: ['/usr/bin/tesseract', '/usr/local/bin/tesseract'],
  },
  installHint: {
    win32: 'winget install UB-Mannheim.TesseractOCR (tick the chi_sim language component)',
    darwin: 'brew install tesseract tesseract-lang',
    linux: 'sudo apt install tesseract-ocr tesseract-ocr-chi-sim',
  },
}

export interface OcrEngine {
  name: string
  recognizePng(png: Buffer, lang: string, ctx: ConvertContext): Promise<string>
}

/** One warmed tesseract.js worker per language set, reused across pages. */
const jsWorkers = new Map<string, Promise<import('tesseract.js').Worker>>()

async function jsWorker(lang: string): Promise<import('tesseract.js').Worker> {
  let pending = jsWorkers.get(lang)
  if (!pending) {
    pending = (async () => {
      const { createWorker } = await import('tesseract.js')
      // Language data (~10-30 MB per language) downloads into the plugin
      // cache on first use and is reused afterwards.
      const cachePath = path.join(cacheDir(), 'tessdata')
      await fs.mkdir(cachePath, { recursive: true })
      return createWorker(lang, 1, { cachePath })
    })()
    jsWorkers.set(lang, pending)
    pending.catch(() => jsWorkers.delete(lang))
  }
  return pending
}

/**
 * Pick an OCR engine: a locally installed Tesseract CLI first (fast, uses the
 * system's trained language data), then the bundled tesseract.js as a pure-npm
 * fallback. null = nothing usable (the caller reports how to fix it).
 */
export async function resolveOcrEngine(resolve: (dep: BinaryDependency) => Promise<string | null>, logger: Logger): Promise<OcrEngine | null> {
  const cli = await resolve(TESSERACT)
  if (cli) {
    logger.debug(`ocr engine: tesseract CLI at ${cli}`)
    return {
      name: 'tesseract-cli',
      async recognizePng(png, lang, ctx) {
        const tmp = path.join(os.tmpdir(), `dsh-ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
        await fs.writeFile(tmp, png)
        try {
          const { stdout } = await execTool(cli, [tmp, 'stdout', '-l', lang], {
            timeoutMs: ctx.timeoutMs,
            signal: ctx.signal,
            maxStderrBytes: 8 * 1024,
          })
          return stdout
        } finally {
          await fs.rm(tmp, { force: true }).catch(() => undefined)
        }
      },
    }
  }
  try {
    await import('tesseract.js')
  } catch (err) {
    logger.debug(`ocr engine: tesseract.js unavailable (${err instanceof Error ? err.message : String(err)})`)
    return null
  }
  logger.debug('ocr engine: tesseract.js (bundled fallback)')
  return {
    name: 'tesseract.js',
    async recognizePng(png, lang) {
      const worker = await jsWorker(lang)
      const { data } = await worker.recognize(png)
      return data.text
    },
  }
}
