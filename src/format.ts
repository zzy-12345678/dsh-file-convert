import type { ConvertResult, ConversionStatus, InspectResult } from './core/index.js'

/** Human-readable, agent-relayable text for conversion results. */

const MAX_LISTED = 20

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

export function formatConvertResult(result: ConvertResult): string {
  if (!result.ok) return formatFailure(result.error)
  const lines = [
    `Converted: ${result.input} (${result.from}) -> ${result.output} (${result.to})`,
    `${formatBytes(result.bytesIn)} -> ${formatBytes(result.bytesOut)} in ${formatDuration(result.durationMs)}`,
  ]
  if (result.outputs && result.outputs.length > 1) {
    lines.push(`Outputs (${result.outputs.length}): ${result.outputs.slice(0, MAX_LISTED).join(', ')}` +
      (result.outputs.length > MAX_LISTED ? ` … +${result.outputs.length - MAX_LISTED} more` : ''))
  }
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`)
  return lines.join('\n')
}

export function formatFailure(error: { code: string; message: string; detail?: string; hint?: string }): string {
  const lines = [`Conversion failed (${error.code}): ${error.message}`]
  if (error.hint) lines.push(`Hint: ${error.hint}`)
  if (error.detail) lines.push(`Detail: ${error.detail}`)
  return lines.join('\n')
}

export function formatInspect(inspect: InspectResult): string {
  return JSON.stringify(inspect, null, 2)
}

export function formatConversionList(statuses: ConversionStatus[]): string {
  const width = Math.max(...statuses.map((s) => `${s.from} -> ${s.to}`.length)) + 2
  const rows = statuses.map((s) => {
    const pair = `${s.from} -> ${s.to}`
    const label = pair.padEnd(width, ' ')
    const state = s.available ? 'available' : `unavailable (missing: ${s.missing.join(', ')})`
    return `${label}${state}${s.experimental ? '  [experimental]' : ''}`
  })
  const unavailable = statuses.filter((s) => !s.available).length
  const footer =
    unavailable === 0
      ? `${statuses.length} conversions, all local, no external dependencies required.`
      : `${statuses.length} conversions, ${unavailable} unavailable. Install the missing tool to enable them.`
  return rows.join('\n') + '\n' + footer
}

export function formatBatchSummary(summary: BatchSummary): string {
  const lines = [
    `Batch convert in ${summary.inputDir} -> ${summary.outputFormat.toUpperCase()}`,
    `Converted: ${summary.converted.length}, skipped: ${summary.skipped.length}, failed: ${summary.failed.length}`,
  ]
  if (summary.outputDir) lines.push(`Output dir: ${summary.outputDir}`)
  if (summary.converted.length > 0) {
    lines.push(`Recently converted:`)
    for (const item of summary.converted.slice(0, MAX_LISTED)) lines.push(`  + ${item}`)
    if (summary.converted.length > MAX_LISTED) lines.push(`  … +${summary.converted.length - MAX_LISTED} more`)
  }
  if (summary.skipped.length > 0) {
    lines.push(`Skipped (already exists, pass overwrite:true to replace):`)
    for (const item of summary.skipped.slice(0, MAX_LISTED)) lines.push(`  = ${item}`)
    if (summary.skipped.length > MAX_LISTED) lines.push(`  … +${summary.skipped.length - MAX_LISTED} more`)
  }
  if (summary.failed.length > 0) {
    lines.push(`Failed:`)
    for (const item of summary.failed.slice(0, MAX_LISTED)) lines.push(`  x ${item}`)
    if (summary.failed.length > MAX_LISTED) lines.push(`  … +${summary.failed.length - MAX_LISTED} more`)
  }
  return lines.join('\n')
}

export interface BatchSummary {
  inputDir: string
  outputDir?: string
  outputFormat: string
  converted: string[]
  skipped: string[]
  failed: string[]
}
