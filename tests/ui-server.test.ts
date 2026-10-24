import fs from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { startUiServer } from '../src/ui/server.js'
import { tmpDir, writeTransparentPng } from './helpers.js'

const server = await startUiServer({ port: 0, workRoot: await tmpDir('dsh-ui-test-') })
const tiny = await startUiServer({ port: 0, workRoot: await tmpDir('dsh-ui-tiny-'), maxUploadBytes: 10 })
afterAll(async () => {
  await server.close()
  await tiny.close()
})

const api = (path: string, init?: RequestInit) =>
  fetch(new URL(path, server.url), {
    ...init,
    headers: { 'x-dsh-token': server.token, ...(init?.headers ?? {}) },
  })

describe('local web UI server', () => {
  it('serves the drag-and-drop page with an injected session token', async () => {
    const page = await (await fetch(server.url)).text()
    expect(page).toContain('把文件拖到这里')
    expect(page).toContain(server.token)
    expect(page).not.toContain('__DSH_UI_TOKEN__')
    // standalone mode is mounted at the origin root, so the base is empty
    expect(page).toContain("const BASE = '';")
  })

  it('rejects API calls without the session token and cross-origin calls', async () => {
    expect((await fetch(new URL('api/conversions', server.url))).status).toBe(403)
    expect(
      (
        await fetch(new URL('api/conversions', server.url), {
          headers: { 'x-dsh-token': 'wrong-token' },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(new URL('api/conversions', server.url), {
          headers: { 'x-dsh-token': server.token, origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403)
  })

  it('accepts same-origin POSTs carrying an Origin header, including loopback spellings', async () => {
    // Browsers always send Origin on cross-method POSTs; the server must
    // compare against the request's Host (with port), not a portless base.
    const withOrigin = await fetch(new URL('api/conversions', server.url), {
      headers: { 'x-dsh-token': server.token, origin: server.url.replace(/\/$/, '') },
    })
    expect(withOrigin.status).toBe(200)

    const localhostUrl = server.url.replace('127.0.0.1', 'localhost')
    const viaLocalhost = await fetch(new URL('api/conversions', localhostUrl), {
      headers: { 'x-dsh-token': server.token, origin: localhostUrl.replace(/\/$/, '') },
    })
    expect(viaLocalhost.status).toBe(200)
  })

  it('reports the capability matrix and limits', async () => {
    const data = (await (await api('api/conversions')).json()) as {
      conversions: Array<{ from: string; to: string }>
      limits: { timeoutMinutes: number }
    }
    expect(data.conversions.length).toBe(26)
    expect(data.limits.timeoutMinutes).toBeGreaterThan(0)
  })

  it('uploads a png, converts it to jpg, and serves the download', async () => {
    const dir = await tmpDir()
    const png = await writeTransparentPng(dir)
    const res = await api('api/convert?name=sample.png&to=jpg', {
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

    const download = await fetch(new URL(data.files[0].url, server.url))
    expect(download.status).toBe(200)
    const bytes = Buffer.from(await download.arrayBuffer())
    // JPEG magic
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    expect(bytes.length).toBe(data.files[0].bytes)
  })

  it('refuses unknown targets and wrong directions with a convertible message', async () => {
    const dir = await tmpDir()
    const png = await writeTransparentPng(dir)
    const unknown = (await (
      await api('api/convert?name=sample.png&to=exe', { method: 'POST', body: await fs.readFile(png) })
    ).json()) as { ok: boolean; code: string }
    expect(unknown.ok).toBe(false)
    expect(unknown.code).toBe('unsupported_conversion')

    const wrongDirection = (await (
      await api('api/convert?name=sample.png&to=mp3', { method: 'POST', body: await fs.readFile(png) })
    ).json()) as { ok: boolean; from: string; code: string }
    expect(wrongDirection.ok).toBe(false)
    expect(wrongDirection.from).toBe('png')
  })

  it('blocks path traversal in download ids', async () => {
    const escape = encodeURIComponent('../../secrets.txt')
    expect((await fetch(`${server.url}api/download/${escape}?token=${server.token}`)).status).toBe(400)
    expect((await fetch(`${server.url}api/download/not-a-uuid/whatever.txt?token=${server.token}`)).status).toBe(400)
  })

  it('refuses uploads above the configured size limit', async () => {
    const res = await fetch(new URL('api/convert?name=big.png&to=jpg', tiny.url), {
      method: 'POST',
      headers: { 'x-dsh-token': tiny.token },
      body: Buffer.alloc(100, 1),
    })
    expect([413, 500]).toContain(res.status)
    const data = (await res.json()) as { error: string }
    expect(data.error).toContain('limit')
  })

  it('never offers to bind a non-loopback interface', async () => {
    await expect(startUiServer({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/loopback/)
  })
})
