import type { ProviderConfig } from './types'

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'

/**
 * Whether this provider can be called at all. Lives in shared/ because the
 * renderer asks the same question the main process does — it decides whether to
 * force the Settings panel open on launch — and a local Ollama daemon is usable
 * with no key, so neither side can check `!apiKey`.
 */
export function hasProviderCredentials(config: ProviderConfig | null | undefined): boolean {
  if (!config) return false
  if (config.type === 'ollama') return true
  if (config.type === 'custom') return Boolean(config.customApiKey.trim())
  return Boolean(config.openrouterApiKey.trim())
}
