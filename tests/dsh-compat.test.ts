import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.js'
import type { Config } from '../src/config.js'

const CONFIG: Config = {
  quality: 85,
  dpi: 150,
  timeoutMs: 120_000,
  batchMaxFiles: 500,
  outputRoots: [],
  maxInputMb: 2048,
  maxPdfPages: 200,
  maxOutputPixels: 16_000_000,
}

const EXPECTED_NAMES = [
  'convert_file',
  'batch_convert',
  'inspect_file',
  'list_conversions',
  'optimize_file',
  'install_media_dependencies',
  'install_ocr_dependencies',
]

const VALID_ARGS: Record<string, Record<string, unknown>> = {
  convert_file: { input: 'C:/input.pdf', output_format: 'png' },
  batch_convert: { input_dir: 'C:/input', output_format: 'png' },
  inspect_file: { input: 'C:/input.pdf' },
  list_conversions: {},
  optimize_file: { input: 'C:/input.pdf', target_size_mb: 1 },
  install_media_dependencies: {},
  install_ocr_dependencies: {},
}

function loadDefinitions(): ToolDefinition[] {
  const definitions: ToolDefinition[] = []
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        definitions.push(definition)
        return () => {}
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  apply(ctx as never, CONFIG)
  return definitions
}

describe('DeepSeek Harness 0.1.2 compatibility', () => {
  it('declares the current host runtime peers and bundle patch', async () => {
    const manifest = JSON.parse(
      await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dsh?: { bundle?: { patch?: string } }
      peerDependencies?: Record<string, string>
    }

    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.peerDependencies).toMatchObject({
      '@deepseek-ai/cordis': '^4.0.2',
      '@deepseek-ai/dsh-tools': '^0.1.2-rc.1',
    })
  })

  it('registers seven canonical-output definitions for the new tool runtime', () => {
    const definitions = loadDefinitions()
    expect(definitions.map((definition) => definition.name)).toEqual(EXPECTED_NAMES)

    for (const definition of definitions) {
      expect(definition.output.schema).toEqual({ type: 'string' })
      expect(definition.output.render(VALID_ARGS[definition.name], 'ok')).toEqual([
        { type: 'text', text: 'ok' },
      ])
      expect(definition.isConcurrencySafe).toBeTypeOf('function')
      expect(definition.isConcurrencySafe?.(VALID_ARGS[definition.name])).toBe(
        !definition.name.startsWith('install_'),
      )
    }
  })

  it('uses the 0.1.2 strict argument validator', async () => {
    const convert = loadDefinitions().find((definition) => definition.name === 'convert_file')
    await expect(convert?.execute({}, {} as never)).rejects.toMatchObject({
      code: 'INVALID_ARGS',
    })
  })
})
