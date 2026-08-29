import type { ConvertError, ConvertErrorCode } from './types.js'

/** Detail output longer than this is truncated into ConvertError.detail. */
const MAX_DETAIL = 2048

export function convertError(
  code: ConvertErrorCode,
  message: string,
  extra: Partial<Omit<ConvertError, 'code' | 'message'>> = {},
): ConvertError {
  return { code, message, ...extra }
}

export function truncate(text: string, max = MAX_DETAIL): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : clean.slice(0, max) + `… (+${clean.length - max} chars)`
}

/** Normalize an unknown thrown value into a ConvertError. */
export function toConvertError(err: unknown, fallbackMessage: string): ConvertError {
  if (err instanceof Error) {
    return convertError('conversion_failed', fallbackMessage, { detail: truncate(err.stack ?? err.message) })
  }
  return convertError('conversion_failed', fallbackMessage, { detail: truncate(String(err)) })
}
