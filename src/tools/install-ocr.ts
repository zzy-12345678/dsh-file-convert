import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Logger } from '../core/index.js'
import { TESSERACT, installOcrLanguages, ocrLanguagesCached, resolveBinary, tessdataDir } from '../core/index.js'
import type { Config } from '../config.js'
import { formatBytes } from '../format.js'

/**
 * Explicit consent path for OCR language data: downloads tesseract.js packs
 * into the plugin cache. Conversions never download these implicitly.
 */
export function createInstallOcrTool(config: Config, logger: Logger) {
  return defineTool({
    name: 'install_ocr_dependencies',
    description:
      'Download OCR language data for the bundled tesseract.js engine (about 10-30 MB per language, cached in ~/.dsh-file-convert/tessdata) so pdf -> txt with ocr: true works without a local Tesseract. Ask the user for consent before calling. Skips when a local Tesseract CLI is installed or the data is already cached.',
    parameters: {
      lang: { type: 'string', description: "OCR languages, '+'-separated. Default 'chi_sim+eng'." },
      force: { type: 'boolean', description: 'Re-download even if the language data is already cached. Default false.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: Math.max(config.timeoutMs, 900_000),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const lang = args.lang ?? 'chi_sim+eng'
      const overrides: Record<string, string> = {}
      if (config.tesseractPath) overrides.tesseractPath = config.tesseractPath

      const cli = await resolveBinary(TESSERACT, overrides, logger)
      if (cli && args.force !== true) {
        return `Local Tesseract found at ${cli} - OCR works without any download (languages come from its own traineddata).`
      }
      if (args.force !== true && (await ocrLanguagesCached(lang))) {
        return `Language data for '${lang}' is already cached in ${tessdataDir()}. Nothing to do.`
      }

      const t0 = Date.now()
      const { files, bytes } = await installOcrLanguages(lang, { logger, signal: exec.signal })
      return [
        'OCR language data ready:',
        `+ ${lang}: ${files.join(', ')} (${formatBytes(bytes)}) in the plugin cache`,
        `Downloaded in ${Math.round((Date.now() - t0) / 100) / 10}s. No restart needed.`,
      ].join('\n')
    },
  })
}
