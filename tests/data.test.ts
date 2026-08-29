import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { createRouter } from '../src/core/index.js'
import { tmpDir, writeFile } from './helpers.js'

const router = createRouter()
const NULL_LOGGER = { debug() {}, info() {}, warn() {}, error() {} }

function convert(input: string, outputFormat: string, output: string) {
  return router.convertFile({ input, outputFormat, output }, { logger: NULL_LOGGER })
}

describe('data conversions', () => {
  it('json -> yaml -> json round-trips', async () => {
    const dir = await tmpDir()
    const input = await writeFile(dir, 'data.json', JSON.stringify({ name: 'dsh', tags: ['a', 'b'], nested: { ok: true } }))
    const mid = path0(dir, 'data.yaml')
    const result = await convert(input, 'yaml', mid)
    expect(result.ok).toBe(true)
    const loaded = yaml.load(await fs.readFile(mid, 'utf8'))
    expect(loaded).toEqual({ name: 'dsh', tags: ['a', 'b'], nested: { ok: true } })

    const back = path0(dir, 'data2.json')
    const result2 = await convert(mid, 'json', back)
    expect(result2.ok).toBe(true)
    expect(JSON.parse(await fs.readFile(back, 'utf8'))).toEqual(loaded)
  })

  it('csv -> json strips BOM and sniffs semicolon delimiters', async () => {
    const dir = await tmpDir()
    const input = await writeFile(dir, 'people.csv', '﻿name;age\nAlice;30\nBob;25\n')
    const result = await convert(input, 'json', path0(dir, 'people.json'))
    expect(result.ok).toBe(true)
    const rows = JSON.parse(await fs.readFile(path0(dir, 'people.json'), 'utf8'))
    expect(rows).toEqual([
      { name: 'Alice', age: '30' },
      { name: 'Bob', age: '25' },
    ])
  })

  it('json -> csv flattens nested objects with dot notation', async () => {
    const dir = await tmpDir()
    const input = await writeFile(dir, 'nested.json', JSON.stringify([{ a: { b: 1 }, c: [1, 2], d: 'x' }]))
    const result = await convert(input, 'csv', path0(dir, 'nested.csv'))
    expect(result.ok).toBe(true)
    const text = await fs.readFile(path0(dir, 'nested.csv'), 'utf8')
    expect(text).toContain('a.b')
    expect(text).toContain('"[1,2]"')
    expect(text).toContain('x')
  })

  it('yaml -> csv works through the intermediate representation', async () => {
    const dir = await tmpDir()
    const input = await writeFile(dir, 'items.yaml', '- id: 1\n  name: one\n- id: 2\n  name: two\n')
    const result = await convert(input, 'csv', path0(dir, 'items.csv'))
    expect(result.ok).toBe(true)
    const text = await fs.readFile(path0(dir, 'items.csv'), 'utf8')
    expect(text).toContain('id,name')
    expect(text).toContain('one')
  })

  it('reports invalid JSON as invalid_input', async () => {
    const dir = await tmpDir()
    const input = await writeFile(dir, 'broken.json', '{ nope')
    const result = await convert(input, 'yaml', path0(dir, 'broken.yaml'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_input')
  })
})

function path0(dir: string, name: string): string {
  return `${dir}/${name}`
}
