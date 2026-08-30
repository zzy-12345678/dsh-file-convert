import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ExecError, execTool } from './utils/exec.js'
import { cacheDir } from './binaries/cache.js'
import type { BinaryDependency, ConvertContext, Logger } from './types.js'

/**
 * Metadata for the tesseract.js language data, used in dependency errors.
 * Conversions NEVER download it implicitly: without a cached pack they fail
 * with guidance pointing at install_ocr_dependencies.
 */
export const OCR_LANGUAGE_DATA: BinaryDependency = {
  name: 'ocr-language-data',
  displayName: 'OCR language data (tesseract.js)',
  commands: [],
  installHint: {
    win32: 'run the install_ocr_dependencies tool',
    darwin: 'run the install_ocr_dependencies tool',
    linux: 'run the install_ocr_dependencies tool',
  },
}

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
      // cache; only reached via install_ocr_dependencies' explicit consent.
      const cachePath = path.join(cacheDir(), 'tessdata')
      await fs.mkdir(cachePath, { recursive: true })
      return createWorker(lang, 1, { cachePath })
    })()
    jsWorkers.set(lang, pending)
    pending.catch(() => jsWorkers.delete(lang))
  }
  return pending
}

export function tessdataDir(): string {
  return path.join(cacheDir(), 'tessdata')
}

/** True when every language of the set already sits in the plugin cache. */
export async function ocrLanguagesCached(lang: string): Promise<boolean> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(tessdataDir())
  } catch {
    return false
  }
  return lang.split('+').every((l) => entries.some((e) => e.startsWith(`${l}.traineddata`)))
}

/**
 * Explicitly download the language data for `lang` by warming a worker.
 * Called only from install_ocr_dependencies (user consented).
 */
export async function installOcrLanguages(
  lang: string,
  ctx: { logger: Logger; signal?: AbortSignal },
): Promise<{ files: string[]; bytes: number }> {
  void ctx.signal // tesseract.js cannot abort mid-download; the tool's timeout applies
  await jsWorker(lang) // creating the worker downloads the language data
  const entries = await fs.readdir(tessdataDir()).catch(() => [] as string[])
  const files: string[] = []
  let bytes = 0
  for (const l of lang.split('+')) {
    const file = entries.find((e) => e.startsWith(`${l}.traineddata`))
    if (!file) {
      throw new Error(`Language data for '${l}' did not download; check network access to the tesseract.js CDN.`)
    }
    const stat = await fs.stat(path.join(tessdataDir(), file))
    files.push(file)
    bytes += stat.size
  }
  return { files, bytes }
}

/** Thrown by engines when the requested OCR language data is not available. */
export class OcrLanguageMissingError extends Error {
  constructor(readonly lang: string, readonly detail?: string) {
    super(`OCR language data for '${lang}' is not available.`)
  }
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
        } catch (err) {
          // A CLI without the requested traineddata should read as a missing
          // dependency, not as a generic conversion failure.
          if (err instanceof ExecError && err.code === 'failed' && /failed loading language|error opening data file|didn't load any languages/i.test(err.stderr ?? '')) {
            throw new OcrLanguageMissingError(lang, err.stderr)
          }
          throw err
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
