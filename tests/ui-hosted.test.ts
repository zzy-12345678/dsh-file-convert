import fs from 'node:fs/promises'
import http from 'node:http'
import { afterAll, describe, expect, it } from 'vitest'
import { createUiHandler } from '../src/ui/server.js'
import { tmpDir, writeTransparentPng } from './helpers.js'

interface RecordedRoute {
  kind: 'prefix' | 'exact'
  path: string
  handler(req: http.IncomingMessage, res: http.ServerResponse): void | Promise<void>
}

/** Minimal stand-in for the DSH host's webServer service + its http server. */
const routes: RecordedRoute[] = []
const fakeWebServer = {
  register(route: RecordedRoute) {
    routes.push(route)
  },
}

const hosted = await createUiHandler({
  auth: 'hosted',
  basePath: '/dsh-file-convert',
  workRoot: await tmpDir('dsh-ui-hosted-'),
})
fakeWebServer.register({
  kind: 'prefix',
  path: '/dsh-file-convert',
  handler: (req, res) => {
    void hosted.handle(req, res)
  },
})

const dispatch = http.createServer((req, res) => {
  const route = routes.find((r) => req.url === r.path || req.url?.startsWith(`${r.path}/`))
  if (!route) {
    res.statusCode = 404
    res.end()
    return
  }
  void route.handler(req, res)
})
await new Promise<void>((resolve) => dispatch.listen(0, '127.0.0.1', () => resolve()))
const address = dispatch.address() as import('node:net').AddressInfo
const base = `http://127.0.0.1:${address.port}`

afterAll(async () => {
  await hosted.close()
  await new Promise<void>((resolve) => dispatch.close(() => resolve()))
})

describe('UI mounted on the DSH web server', () => {
  it('serves the page and API under the mount prefix without a token', async () => {
    const page = await fetch(`${base}/dsh-file-convert/`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('把文件拖到这里')
    // the page must address the API under the mount prefix, not the origin root
    expect(html).toContain(`const BASE = '/dsh-file-convert'`)

    const conversions = await fetch(`${base}/dsh-file-convert/api/conversions`)
    expect(conversions.status).toBe(200)
    const data = (await conversions.json()) as { conversions: unknown[] }
    expect(data.conversions.length).toBe(26)
  })

  it('404s paths outside the mount prefix', async () => {
    expect((await fetch(`${base}/api/conversions`)).status).toBe(404)
  })

  it('still rejects cross-origin conversions in hosted mode', async () => {
    const res = await fetch(`${base}/dsh-file-convert/api/convert?name=x.png&to=jpg`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: 'not-a-png',
    })
    expect(res.status).toBe(403)
  })

  it('converts an upload end-to-end through the mounted routes', async () => {
    const dir = await tmpDir()
    const png = await writeTransparentPng(dir)
    const res = await fetch(`${base}/dsh-file-convert/api/convert?name=sample.png&to=jpg`, {
      method: 'POST',
      body: await fs.readFile(png),
    })
    const data = (await res.json()) as {
      ok: boolean
      from: string
      to: string
      files: Array<{ url: string; bytes: number }>
    }
    expect(data.ok).toBe(true)
    expect(data.from).toBe('png')
    expect(data.to).toBe('jpg')

    // the returned download url already carries the mount prefix
    const download = await fetch(new URL(data.files[0].url, base))
    expect(download.status).toBe(200)
    const bytes = Buffer.from(await download.arrayBuffer())
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
  })
})

describe('DSH client bundle', () => {
  it('follows the __ModuleLoader__ contract and mounts a conversation.view slot', async () => {
    const code = await fs.readFile(new URL('../src/ui/assets/client.js', import.meta.url), 'utf8')
    expect(() => new Function(code)).not.toThrow()
    expect(code).toContain("window.__ModuleLoader__.load")
    expect(code).toContain("id: 'dsh-file-convert'")
    expect(code).toContain("inject = ['slots']")
    expect(code).toContain("'conversation.view'")
    expect(code).toContain("'/dsh-file-convert/'")
  })
})

describe('plugin apply is idempotent for the host webServer', () => {
  it('tolerates the host applying the plugin twice without a fatal duplicate route', async () => {
    const { apply } = await import('../src/index.js')
    const routes = new Map<string, number>()
    const webServer = {
      register(route: { kind: string; path: string }) {
        if (routes.has(route.path)) {
          throw new Error(`webserver: duplicate prefix route "${route.path}"`)
        }
        routes.set(route.path, 1)
      },
    }
    const makeCtx = () => ({
      tools: { register() {} },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      webServer,
    })
    const config = {
      quality: 85, dpi: 150, timeoutMs: 120_000, batchMaxFiles: 500, outputRoots: [],
      maxInputMb: 2048, maxPdfPages: 200, maxOutputPixels: 16_000_000,
      uiAutoStart: false, uiTimeoutMin: 30,
    }
    // The DSH host applied the plugin twice at startup and treated the second
    // registration as a fatal load failure; apply must mount exactly once.
    expect(() => apply(makeCtx() as never, config as never)).not.toThrow()
    expect(() => apply(makeCtx() as never, config as never)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(routes.get('/dsh-file-convert')).toBe(1)
  })
})
