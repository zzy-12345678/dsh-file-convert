import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertUnpublished, validateRelease } from './check-release.mjs'

function fixtures() {
  const manifest = { name: 'example', version: '0.5.2', devDependencies: { host: 'rc.5' } }
  return { manifest, lock: { ...manifest, packages: { '': structuredClone(manifest) } } }
}

test('accepts aligned metadata and tag', () => {
  const { manifest, lock } = fixtures()
  assert.doesNotThrow(() => validateRelease(manifest, lock, 'v0.5.2'))
})

test('rejects a tag pointing to a different package version', () => {
  const { manifest, lock } = fixtures()
  assert.throws(() => validateRelease(manifest, lock, 'v0.5.1'), /does not match/)
})

test('rejects stale root and package lock versions', () => {
  for (const root of [true, false]) {
    const { manifest, lock } = fixtures()
    if (root) lock.version = '0.5.0'
    else lock.packages[''].version = '0.5.0'
    assert.throws(() => validateRelease(manifest, lock), /same name and version/)
  }
})

test('rejects stale peer closure pins even when versions match', () => {
  const { manifest, lock } = fixtures()
  lock.packages[''].devDependencies.host = 'rc.3'
  assert.throws(() => validateRelease(manifest, lock), /Lockfile mismatch/)
})

test('only a registry 404 means the version is available', async () => {
  await assert.doesNotReject(() => assertUnpublished('example', '0.5.2', async () => ({ status: 404 })))
  await assert.rejects(() => assertUnpublished('example', '0.5.2', async () => ({ status: 200, ok: true })), /already published/)
  await assert.rejects(() => assertUnpublished('example', '0.5.2', async () => ({ status: 503 })), /Cannot verify/)
  await assert.rejects(() => assertUnpublished('example', '0.5.2', async () => { throw new Error('ECONNRESET') }), /ECONNRESET/)
})

test('retries a transient registry failure before accepting a 404', async () => {
  let calls = 0
  await assertUnpublished('example', '0.5.2', async () => {
    if (++calls === 1) throw new Error('ECONNRESET')
    return { status: 404 }
  })
  assert.equal(calls, 2)
})
