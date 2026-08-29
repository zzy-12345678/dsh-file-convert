import { spawn } from 'node:child_process'
import { truncate } from '../errors.js'

export interface ExecOptions {
  /** Hard deadline in milliseconds; the child is killed when it fires. */
  timeoutMs: number
  /** Cooperative cancellation from the harness (agent abort). */
  signal?: AbortSignal
  /** Max stderr bytes kept for diagnostics. */
  maxStderrBytes?: number
}

export interface ExecOutcome {
  code: number
  stdout: string
  stderr: string
}

export class ExecError extends Error {
  constructor(
    readonly code: 'timeout' | 'cancelled' | 'failed',
    message: string,
    readonly stderr?: string,
  ) {
    super(message)
  }
}

/**
 * Run an external tool, collecting stderr. Hardened for ffmpeg-style long
 * jobs: no shell (array args), timeout kill, cooperative abort, capped
 * stderr, hidden console window on Windows.
 */
export function execTool(command: string, args: string[], opts: ExecOptions): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let settled = false
    const stderrCap = opts.maxStderrBytes ?? 64 * 1024
    let stderrBytes = 0
    const stderrChunks: Buffer[] = []
    const stdoutChunks: Buffer[] = []

    let timer: NodeJS.Timeout | undefined
    const onAbort = () => {
      if (!settled) child.kill('SIGKILL')
    }

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        child.kill('SIGKILL')
        return finish(() => reject(new ExecError('cancelled', 'Conversion cancelled.')))
      }
      opts.signal.addEventListener('abort', onAbort)
    }

    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new ExecError('timeout', `External tool timed out after ${Math.round(opts.timeoutMs / 1000)}s: ${command}`, Buffer.concat(stderrChunks).toString('utf8'))))
    }, opts.timeoutMs)

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= stderrCap) return
      stderrChunks.push(chunk)
      stderrBytes += chunk.length
    })

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
    })

    child.on('error', (err) => {
      finish(() => reject(new ExecError('failed', `Failed to run ${command}: ${err.message}`)))
    })

    child.on('close', (code, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      if (opts.signal?.aborted) {
        return finish(() => reject(new ExecError('cancelled', 'Conversion cancelled.', stderr)))
      }
      if (signal) {
        return finish(() => reject(new ExecError('timeout', `External tool was killed (${signal}): ${command}`, truncate(stderr))))
      }
      if (code !== 0) {
        return finish(() => reject(new ExecError('failed', `${command} exited with code ${code}`, truncate(stderr))))
      }
      finish(() => resolve({ code: code ?? 0, stdout, stderr }))
    })
  })
}

/** ffprobe wrapper: one JSON document about the file's format and streams. */
export async function probeMedia(
  ffprobePath: string,
  input: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<MediaProbe | null> {
  try {
    const { stdout } = await execTool(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input],
      { timeoutMs, signal, maxStderrBytes: 8 * 1024 },
    )
    return JSON.parse(stdout) as MediaProbe
  } catch {
    return null
  }
}

export interface MediaProbe {
  format?: { duration?: string }
  streams?: Array<{
    codec_type?: string
    codec_name?: string
    width?: number
    height?: number
    r_frame_rate?: string
  }>
}
