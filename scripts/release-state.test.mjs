import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ensureRelease, npmState } from './release-state.mjs'

const manifest = { name: 'dsh-file-convert', version: '0.5.2' }
const commit = '1234567890abcdef'
const release = { tag_name: 'v0.5.2', draft: false, html_url: 'https://github.com/example/repo/releases/tag/v0.5.2' }
const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data })
const sleep = async () => {}

test('skips npm publishing only for the same package, version and commit', async () => {
  assert.equal(await npmState(manifest, commit, async () => response(200, { ...manifest, gitHead: commit })), true)
  for (const change of [{ name: 'other' }, { version: '0.5.1' }, { gitHead: 'other' }, { gitHead: undefined }]) {
    await assert.rejects(() => npmState(manifest, commit, async () => response(200, { ...manifest, gitHead: commit, ...change })), /different package or commit/)
  }
})

test('only an npm 404 permits first-time publishing', async () => {
  assert.equal(await npmState(manifest, commit, async () => response(404)), false)
  for (const status of [401, 429, 500]) {
    await assert.rejects(() => npmState(manifest, commit, async () => response(status)), /npm lookup failed/)
  }
  await assert.rejects(() => npmState(manifest, commit, async () => { throw new Error('offline') }), /offline/)
})

test('an existing public GitHub release performs no POST', async () => {
  const calls = []
  const url = await ensureRelease('example/repo', 'v0.5.2', 'test-token', {
    sleep,
    get: async (url, options) => { calls.push(options.method ?? 'GET'); return response(200, release) },
  })
  assert.equal(url, release.html_url)
  assert.deepEqual(calls, ['GET'])
})

test('a transient creation HTTP 500 is retried after checking existence', async () => {
  const calls = []
  const replies = [response(404), response(500), response(404), response(201, release)]
  assert.equal(await ensureRelease('example/repo', 'v0.5.2', 'test-token', {
    sleep,
    get: async (url, options) => { calls.push(options.method ?? 'GET'); return replies.shift() },
  }), release.html_url)
  assert.deepEqual(calls, ['GET', 'POST', 'GET', 'POST'])
})

test('a lost creation response does not cause duplicate creation', async () => {
  const calls = []
  assert.equal(await ensureRelease('example/repo', 'v0.5.2', 'test-token', {
    sleep,
    get: async (url, options) => {
      calls.push(options.method ?? 'GET')
      if (calls.length === 1) return response(404)
      if (calls.length === 2) throw new Error('response lost after server created release')
      return response(200, release)
    },
  }), release.html_url)
  assert.deepEqual(calls, ['GET', 'POST', 'GET'])
})

test('permanent failures stay failures', async () => {
  await assert.rejects(() => ensureRelease('example/repo', 'v0.5.2', 'test-token', {
    sleep, get: async () => response(403),
  }), /lookup failed/)
  await assert.rejects(() => ensureRelease('example/repo', 'v0.5.2', 'test-token', {
    sleep, get: async (url, options) => response(options.method === 'POST' ? 403 : 404),
  }), /creation failed: HTTP 403/)
  await assert.rejects(() => ensureRelease('example/repo', 'v0.5.2', 'test-token', {
    sleep, get: async (url, options) => response(options.method === 'POST' ? 500 : 404),
  }), /after retries/)
})

test('a draft or mismatched existing release is not reported as complete', async () => {
  for (const change of [{ draft: true }, { tag_name: 'v0.5.1' }]) {
    await assert.rejects(() => ensureRelease('example/repo', 'v0.5.2', 'test-token', {
      sleep, get: async () => response(200, { ...release, ...change }),
    }), /draft or has an unexpected tag/)
  }
})
