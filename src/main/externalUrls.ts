const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])

export function isAllowedExternalUrl(value: string): boolean {
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}
