#!/usr/bin/env node
/**
 * Local web UI for dsh-file-convert: drag files into the browser, pick a
 * target format, download the result.
 *
 * Two hosting modes share one request handler:
 * - standalone (`startUiServer`): its own http server on 127.0.0.1, gated by
 *   a random per-session token, so nothing outside this machine can use it.
 * - hosted in DSH (`createUiHandler` mounted by the plugin): served under
 *   /dsh-file-convert on the DSH web server, trusting the host's own gate.
 *
 * Files never leave the machine in either mode: uploads stream to a private
 * workspace and results are served back as downloads.
 */
import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRouter, defaultOutputPath, parseFormatArg, FORMAT_IDS } from '../core/index.js'
import type { Logger } from '../core/types.js'

export interface UiHandlerOptions {
  /** Per-conversion deadline. Default 30 min - UI users convert long videos. */
  timeoutMs?: number
  /** Refuse uploads above this size. Default matches the router's 2 GiB input cap. */
  maxUploadBytes?: number
  /** Private workspace root. Default: a fresh mkdtemp under the OS temp dir. */
  workRoot?: string
  /**
   * 'token' (default) gates every API call behind a random per-session token.
   * 'hosted' skips the token: the DSH web server's own gate applies.
   */
  auth?: 'token' | 'hosted'
  /** Mount the handler under this path prefix (hosted mode); stripped before routing. */
  basePath?: string
  logger?: Logger
}

export interface UiHandler {
  /** Session token; empty in hosted mode. */
  token: string
  workRoot: string
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** Drop the workspace; safe to call repeatedly. */
  close(): Promise<void>
}

export interface UiServerOptions extends UiHandlerOptions {
  /** Listen port; 0 picks a free one. Default 5757, walking up if taken. */
  port?: number
  /** Bind address. Default 127.0.0.1 - deliberately not configurable to a public interface. */
  host?: string
  /** Open the default browser once listening. Default false. */
  openBrowser?: boolean
}

export interface UiServerHandle extends UiHandler {
  url: string
  port: number
  close(): Promise<void>
}

const NULL_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} }

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.yaml': 'text/yaml',
  '.yml': 'text/yaml', '.csv': 'text/csv', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export async function createUiHandler(options: UiHandlerOptions = {}): Promise<UiHandler> {
  const logger = options.logger ?? NULL_LOGGER
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000
  const maxUploadBytes = options.maxUploadBytes ?? 2 * 1024 ** 3
  const auth = options.auth ?? 'token'
  const basePath = (options.basePath ?? '').replace(/\/+$/, '')
  const token = auth === 'token' ? crypto.randomBytes(24).toString('hex') : ''
  const workRoot = options.workRoot ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-file-convert-ui-')))
  await fs.mkdir(path.join(workRoot, 'out'), { recursive: true })

  const router = createRouter({ timeoutMs, maxInputBytes: maxUploadBytes })
  const loggerShim: Logger = {
    debug() {},
    info() {},
    warn: (msg: string) => logger.warn(msg),
    error: (msg: string) => logger.error(msg),
  }

  let htmlCache: string | undefined
  async function indexHtml(): Promise<string> {
    htmlCache ??= await fs.readFile(path.join(assetsDir(), 'index.html'), 'utf8')
    return htmlCache
      .replaceAll('__DSH_UI_TOKEN__', token)
      .replaceAll('__DSH_UI_BASE__', basePath)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      // Build the URL from the request's own Host so the port (and thus the
      // Origin comparison) is always right, whatever the mounting looks like.
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      let pathname = url.pathname
      if (basePath) {
        if (pathname === basePath) pathname = '/'
        else if (pathname.startsWith(`${basePath}/`)) pathname = pathname.slice(basePath.length)
        else return send(404, { error: 'Not found.' })
      }

      // A hostile web page can always fire requests at 127.0.0.1; the Origin
      // check keeps them useless. The comparison runs against the request's
      // own Host header and tolerates loopback spellings (127.0.0.1 /
      // localhost / [::1]) of the same port.
      if (!isSameOrigin(req.headers.origin, req.headers.host)) {
        return send(403, { error: 'Cross-origin requests are not allowed.' })
      }
      const authorized = auth === 'hosted' || url.searchParams.get('token') === token || req.headers['x-dsh-token'] === token
      if (pathname.startsWith('/api/') && !authorized) return send(403, { error: 'Invalid or missing session token.' })

      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(await indexHtml())
        return
      }

      if (req.method === 'GET' && pathname === '/api/conversions') {
        const conversions = await router.listConversions()
        send(200, {
          conversions,
          limits: { maxUploadBytes, timeoutMinutes: Math.round(timeoutMs / 60000) },
        })
        return
      }

      if (req.method === 'POST' && pathname === '/api/convert') {
        await handleConvert(req, res, url)
        return
      }

      if (req.method === 'GET' && pathname.startsWith('/api/download/')) {
        // ids look like <job-uuid>/<filename>; both halves are validated so the
        // resolved path can never leave the private out/ workspace.
        const id = decodeURIComponent(pathname.slice('/api/download/'.length))
        const slash = id.indexOf('/')
        const jobId = slash === -1 ? '' : id.slice(0, slash)
        const fileName = slash === -1 ? '' : id.slice(slash + 1)
        const validId = /^[0-9a-f-]{36}$/i.test(jobId) && fileName && !fileName.includes('/') && !fileName.includes('\\') && !fileName.includes('..')
        if (!validId) {
          return send(400, { error: 'Bad download id.' })
        }
        const file = path.join(workRoot, 'out', jobId, fileName)
        try {
          const stat = await fs.stat(file)
          res.writeHead(200, {
            'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
            'content-length': stat.size,
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          })
          await pipeline(createReadStream(file), res)
        } catch {
          send(404, { error: `Unknown download: ${id}` })
        }
        return
      }

      send(404, { error: 'Not found.' })
    } catch (err) {
      if (!res.headersSent) {
        send(500, { error: err instanceof Error ? err.message : String(err) })
      } else {
        res.destroy()
      }
    }
  }

  async function handleConvert(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const name = sanitizeName(decodeURIComponent(url.searchParams.get('name') ?? 'upload'))
    const to = parseFormatArg(url.searchParams.get('to') ?? '')
    const quality = positiveInt(url.searchParams, 'quality', 1, 100)
    const dpi = positiveInt(url.searchParams, 'dpi', 1, 1200)
    if (!to) {
      return send(200, {
        ok: false,
        code: 'unsupported_conversion',
        message: `Unknown output format '${url.searchParams.get('to') ?? ''}'.`,
        hint: `Supported formats: ${FORMAT_IDS.join(', ')}.`,
      })
    }

    const id = crypto.randomUUID()
    const workDir = path.join(workRoot, 'jobs', id)
    const uploadPath = path.join(workDir, name)
    await fs.mkdir(path.dirname(uploadPath), { recursive: true })

    // Closing the tab mid-conversion must actually stop the underlying work.
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) abort.abort()
    })

    const declaredLength = Number(req.headers['content-length'] ?? '')
    if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) {
      send(413, { error: `Upload exceeds the ${Math.round(maxUploadBytes / 1048576)} MB limit.` })
      req.destroy()
      return
    }

    try {
      await pipeline(req, new UploadLimit(maxUploadBytes), createWriteStream(uploadPath))
      const received = (await fs.stat(uploadPath)).size
      if (received === 0) return send(400, { error: 'Empty upload.' })

      // Outputs live in a per-job folder under out/ so they survive until the
      // user downloads them and can never collide across concurrent jobs.
      const outDir = path.join(workRoot, 'out', id)
      await fs.mkdir(outDir, { recursive: true })
      const output = path.join(outDir, path.basename(defaultOutputPath(uploadPath, to)))
      const result = await router.convertFile(
        {
          input: uploadPath,
          outputFormat: to,
          output,
          ...(quality !== undefined ? { quality } : {}),
          ...(dpi !== undefined ? { dpi } : {}),
        },
        { logger: loggerShim, signal: abort.signal },
      )

      if (!result.ok) {
        const detail = 'detail' in result.error ? result.error.detail : undefined
        const hint = 'hint' in result.error ? result.error.hint : undefined
        return send(200, {
          ok: false,
          from: result.from,
          to: result.to,
          code: result.error.code,
          message: result.error.message,
          ...(detail ? { detail } : {}),
          ...(hint ? { hint } : {}),
        })
      }

      const produced = (result.outputs ?? [result.output]).filter(Boolean) as string[]
      const files = []
      for (const file of produced) {
        const base = path.basename(file)
        try {
          const stat = await fs.stat(file)
          const query = token ? `?token=${token}` : ''
          files.push({ id: base, name: base, bytes: stat.size, url: `${basePath}/api/download/${id}/${encodeURIComponent(base)}${query}` })
        } catch {
          /* a listed output vanished; skip it */
        }
      }
      if (files.length === 0) return send(500, { error: 'Conversion reported success but produced no files.' })

      send(200, {
        ok: true,
        from: result.from,
        to: result.to,
        bytesIn: result.bytesIn,
        bytesOut: result.bytesOut,
        durationMs: result.durationMs,
        warnings: result.warnings,
        files,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith('Upload exceeds')) {
        send(413, { error: message })
      } else {
        send(500, { error: message })
      }
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  return {
    token,
    workRoot,
    handle,
    close: async () => {
      await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServerHandle> {
  const logger = options.logger ?? NULL_LOGGER
  const host = options.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`The UI refuses to bind to ${host}: it serves local files and only ever listens on the loopback interface.`)
  }
  const requestedPort = options.port ?? 5757
  const handler = await createUiHandler(options)

  const server = http.createServer((req, res) => {
    void handler.handle(req, res)
  })

  // Port walks up a few slots so a second instance "just works".
  await new Promise<void>((resolve, reject) => {
    let attempts = 0
    const tryListen = (port: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && requestedPort !== 0 && attempts < 10) {
          attempts += 1
          tryListen(port + 1)
        } else {
          reject(err)
        }
      })
      server.listen(port, host, () => resolve())
    }
    tryListen(requestedPort)
  })
  const address = server.address() as import('node:net').AddressInfo
  const url = `http://${host}:${address.port}/`

  const handleRef: UiServerHandle = {
    ...handler,
    url,
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await handler.close()
    },
  }
  logger.info(`dsh-file-convert UI listening on ${url} (bind ${host}, timeout ${Math.round((options.timeoutMs ?? 30 * 60 * 1000) / 60000)} min)`)
  if (options.openBrowser) openBrowser(url)
  return handleRef
}

/** Rejects the stream the moment it runs past the upload budget. */
class UploadLimit extends Transform {
  private received = 0
  constructor(private readonly limit: number) {
    super()
  }
  override _transform(chunk: Buffer, _enc: string, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.received += chunk.length
    if (this.received > this.limit) {
      cb(new Error(`Upload exceeds the ${Math.round(this.limit / 1048576)} MB limit.`))
      return
    }
    cb(null, chunk)
  }
}

/**
 * True when the request carries no Origin (curl, same-origin GET) or its
 * origin matches the request's Host header - either verbatim or as another
 * loopback spelling of the same port. A page on a different site cannot forge
 * the Origin header, so this only ever admits the UI's own page.
 */
function isSameOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin) return true
  if (!hostHeader) return false
  try {
    const o = new URL(origin)
    const h = new URL(`http://${hostHeader}`)
    if (o.host === h.host) return true
    const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$/
    return o.port === h.port && loopback.test(o.hostname) && loopback.test(h.hostname)
  } catch {
    return false
  }
}

function sanitizeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? 'upload'
  const cleaned = base
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '')
    .trim()
    .replace(/^[. ]+/, '')
    .slice(0, 120)
  return cleaned || 'upload'
}

function positiveInt(params: URLSearchParams, key: string, min: number, max: number): number | undefined {
  const raw = params.get(key)
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) return undefined
  return Math.round(value)
}

function assetsDir(): string {
  // lib/ui/server.js -> lib/ui/assets; src/ui/server.ts -> src/ui/assets (vitest/dev).
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets')
}

/** Best-effort "open the user's browser at url"; failures are silent. */
export function openBrowser(url: string): void {
  const command =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.unref()
  } catch {
    /* best effort - the URL is printed anyway */
  }
}

/** CLI entry: `npm run ui` (or `node lib/ui/server.js`). */
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const args = process.argv.slice(2)
  const flag = (name: string) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 ? args[index + 1] : undefined
  }
  startUiServer({
    port: flag('port') ? Number(flag('port')) : undefined,
    openBrowser: !args.includes('--no-open'),
    timeoutMs: flag('timeout-min') ? Number(flag('timeout-min')) * 60_000 : undefined,
    maxUploadBytes: flag('max-upload-mb') ? Number(flag('max-upload-mb')) * 1048576 : undefined,
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
