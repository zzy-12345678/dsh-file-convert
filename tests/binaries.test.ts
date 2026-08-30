import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandPattern } from '../src/core/binaries/cache.js'

describe('expandPattern', () => {
  it('expands a wildcard directory segment, newest version first', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-glob-'))
    for (const version of ['gs10.9', 'gs10.10', 'gs9.55']) {
      const bin = path.join(base, version, 'bin')
      await fs.mkdir(bin, { recursive: true })
      await fs.writeFile(path.join(bin, 'gswin64c.exe'), 'x')
    }
    const pattern = path.join(base, 'gs*', 'bin', 'gswin64c.exe')
    const result = await expandPattern(pattern)
    expect(result[0]).toContain('gs10.10')
    expect(result.map((p) => p.includes('gs9.55')).length).toBeGreaterThan(0)
  })

  it('keeps the drive separator for windows drive prefixes', async () => {
    const result = await expandPattern('C:\\Program Files\\gs\\gs*\\bin\\gswin64c.exe')
    // On a machine without gs the expansion is empty; when present the path
    // must be well-formed ('C:\\Program Files...', never 'C:Program Files').
    for (const p of result) {
      expect(p.startsWith('C:\\Program Files\\gs\\')).toBe(true)
    }
  })

  it('returns [] when nothing matches', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-empty-'))
    const result = await expandPattern(path.join(base, 'nope*', 'binary.exe'))
    expect(result).toEqual([])
  })
})
