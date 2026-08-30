import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ExecError, execTool } from '../utils/exec.js'
import { convertError } from '../errors.js'
import type {
  BinaryDependency,
  ConvertContext,
  ConvertRequest,
  ConvertResult,
  Converter,
  ConversionCapability,
} from '../types.js'

export const SOFFICE: BinaryDependency = {
  name: 'soffice',
  displayName: 'LibreOffice',
  commands: ['soffice'],
  configKey: 'sofficePath',
  extraPaths: {
    win32: [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    ],
    darwin: ['/Applications/LibreOffice.app/Contents/MacOS/soffice'],
    linux: ['/usr/lib/libreoffice/program/soffice', '/opt/libreoffice/program/soffice'],
  },
  installHint: {
    win32: 'winget install TheDocumentFoundation.LibreOffice',
    darwin: 'brew install --cask libreoffice',
    linux: 'sudo apt install libreoffice-writer libreoffice-calc libreoffice-impress',
  },
}

export const PYTHON_PDF2DOCX: BinaryDependency = {
  name: 'python',
  displayName: 'python with the pdf2docx package',
  commands: ['python', 'python3', 'py'],
  configKey: 'pythonPath',
  probe: async (pythonPath) => {
    try {
      await execTool(pythonPath, ['-c', 'import pdf2docx'], { timeoutMs: 30_000 })
      return true
    } catch {
      return false
    }
  },
  installHint: {
    win32: 'install Python from python.org, then: pip install pdf2docx',
    darwin: 'brew install python && pip3 install pdf2docx',
    linux: 'sudo apt install python3-pip && pip3 install pdf2docx',
  },
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function fail(req: ConvertRequest, error: import('../types.js').ConvertError): ConvertResult {
  return { ok: false, input: req.input, from: req.from, to: req.to, error }
}

/**
 * Office documents to PDF via LibreOffice headless. LibreOffice is a
 * single-instance application, so this converter serializes (concurrency 1)
 * and always runs against its own UserInstallation profile — a document the
 * user has open in LibreOffice GUI must never block or break a conversion.
 */
export class OfficeConverter implements Converter {
  readonly id = 'office'
  readonly concurrency = 1
  readonly binaryDeps = [SOFFICE]

  readonly capabilities: ConversionCapability[] = [
    { from: 'docx', to: 'pdf' },
    { from: 'pptx', to: 'pdf' },
    { from: 'xlsx', to: 'pdf' },
  ]

  constructor(private readonly resolve: (dep: BinaryDependency) => Promise<string | null>) {}

  async convert(req: ConvertRequest, ctx: ConvertContext): Promise<ConvertResult> {
    const started = Date.now()
    try {
      const soffice = await this.required(SOFFICE, req, ctx)
      const bytesIn = (await fs.stat(req.input)).size

      // A stable private profile: created once, reused across conversions.
      const profile = path.join(os.homedir(), '.dsh-file-convert', 'lo-profile')
      await fs.mkdir(profile, { recursive: true })
      const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-office-'))
      try {
        await execTool(
          soffice,
          [
            '--headless', '--norestore', '--nolockcheck',
            `-env:UserInstallation=${pathToFileURL(profile).href}`,
            '--convert-to', 'pdf', '--outdir', outDir,
            req.input,
          ],
          { timeoutMs: ctx.timeoutMs, signal: ctx.signal },
        )
        const produced = path.join(outDir, path.basename(req.input, path.extname(req.input)) + '.pdf')
        if (!(await exists(produced))) {
          return fail(req, convertError('conversion_failed', `LibreOffice did not produce a PDF for ${req.input}.`, {
            hint: 'The document may be corrupt or password-protected; open it once in LibreOffice to check.',
          }))
        }
        await fs.copyFile(produced, req.output)
        return {
          ok: true,
          input: req.input,
          output: req.output,
          from: req.from,
          to: req.to,
          bytesIn,
          bytesOut: (await fs.stat(req.output)).size,
          durationMs: Date.now() - started,
          warnings: [],
        }
      } finally {
        await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined)
      }
    } catch (err) {
      if (err instanceof OfficeDependencyError) {
        return fail(req, convertError('missing_dependency', `Missing external dependency: ${err.dep.displayName ?? err.dep.name}.`, {
          missing: [err.dep],
          hint: `Install hint (${process.platform}): ${err.dep.installHint[platformKey()]}`,
        }))
      }
      if (err instanceof ExecError) {
        const code = err.code === 'timeout' ? 'timeout' : err.code === 'cancelled' ? 'cancelled' : 'conversion_failed'
        return fail(req, convertError(code, `Failed to convert ${req.from} → ${req.to} (LibreOffice).`, { detail: err.stderr }))
      }
      return fail(req, convertError('conversion_failed', `Failed to convert ${req.from} → ${req.to}`, {
        detail: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  private async required(dep: BinaryDependency, req: ConvertRequest, ctx: ConvertContext): Promise<string> {
    const resolved = await this.resolve(dep)
    if (!resolved) throw new OfficeDependencyError(dep)
    void ctx
    return resolved
  }
}

class OfficeDependencyError extends Error {
  constructor(readonly dep: BinaryDependency) {
    super(`Missing dependency: ${dep.name}`)
  }
}

function platformKey(): 'win32' | 'darwin' | 'linux' {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
}

/**
 * PDF → DOCX (EXPERIMENTAL): layout reconstruction via the Python pdf2docx
 * package. Works well on text PDFs; scanned PDFs need OCR (not implemented).
 * The dependency probe checks that python can actually import pdf2docx.
 */
export class PdfToDocxConverter implements Converter {
  readonly id = 'pdf-docx'
  readonly concurrency = 1
  readonly binaryDeps = [PYTHON_PDF2DOCX]

  readonly capabilities: ConversionCapability[] = [{ from: 'pdf', to: 'docx', experimental: true }]

  constructor(private readonly resolve: (dep: BinaryDependency) => Promise<string | null>) {}

  async convert(req: ConvertRequest, ctx: ConvertContext): Promise<ConvertResult> {
    const started = Date.now()
    try {
      const python = await this.resolve(PYTHON_PDF2DOCX)
      if (!python) {
        return fail(req, convertError('missing_dependency', 'Missing external dependency: python with the pdf2docx package.', {
          missing: [PYTHON_PDF2DOCX],
          hint: `Install hint (${process.platform}): ${PYTHON_PDF2DOCX.installHint[platformKey()]}`,
        }))
      }
      const bytesIn = (await fs.stat(req.input)).size
      // pdf2docx has no __main__ module and its console script may not be on
      // PATH - drive the library API directly through the resolved interpreter.
      // It writes its output directly, so use a scratch file in the output's
      // own directory and only publish a complete document under the real name.
      const scratch = path.join(
        path.dirname(req.output),
        `.${path.basename(req.output)}.${Date.now()}.tmp`,
      )
      try {
        await execTool(
          python,
          [
            '-c', 'import sys; from pdf2docx import parse; parse(sys.argv[1], sys.argv[2])',
            req.input, scratch,
          ],
          { timeoutMs: ctx.timeoutMs, signal: ctx.signal },
        )
        if (!(await exists(scratch))) {
          return fail(req, convertError('conversion_failed', 'pdf2docx reported success but produced no file.'))
        }
        await fs.rename(scratch, req.output).catch(async () => {
          await fs.copyFile(scratch, req.output)
          await fs.rm(scratch, { force: true })
        })
      } finally {
        await fs.rm(scratch, { force: true }).catch(() => undefined)
      }
      return {
        ok: true,
        input: req.input,
        output: req.output,
        from: req.from,
        to: req.to,
        bytesIn,
        bytesOut: (await fs.stat(req.output)).size,
        durationMs: Date.now() - started,
        warnings: ['PDF → DOCX is experimental: complex layouts may shift; check the result.'],
      }
    } catch (err) {
      if (err instanceof ExecError) {
        const code = err.code === 'timeout' ? 'timeout' : err.code === 'cancelled' ? 'cancelled' : 'conversion_failed'
        return fail(req, convertError(code, `Failed to convert ${req.from} → ${req.to} (pdf2docx).`, { detail: err.stderr }))
      }
      return fail(req, convertError('conversion_failed', `Failed to convert ${req.from} → ${req.to}`, {
        detail: err instanceof Error ? err.message : String(err),
      }))
    }
  }
}
