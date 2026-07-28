import type { ProviderConfig } from '../shared/types'
import { DEFAULT_OLLAMA_BASE_URL, hasProviderCredentials } from '../shared/providerConfig'

export { DEFAULT_OLLAMA_BASE_URL, hasProviderCredentials }

// Nine main-process modules each carried a private copy of getBaseUrl /
// getApiKey / getHeaders. Adding Ollama to only some of them would have given
// the user working chat and a Timeline/Health/Memory stack that still tried to
// reach OpenRouter, so the resolution lives here once and every subsystem
// imports it.

export function getOllamaBaseUrl(config: ProviderConfig): string {
  const raw = (config.ollamaBaseUrl || '').trim()
  return (raw || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '')
}

export function getBaseUrl(config: ProviderConfig): string {
  if (config.type === 'ollama') {
    const host = getOllamaBaseUrl(config)
    // Accept a host ("http://localhost:11434") or a full OpenAI-compatible base
    // ("http://localhost:11434/v1") — Ollama's docs show both.
    return /\/v\d+$/.test(host) ? host : `${host}/v1`
  }
  if (config.type === 'custom' && config.customBaseUrl) {
    return config.customBaseUrl.replace(/\/+$/, '')
  }
  return 'https://openrouter.ai/api/v1'
}

export function getApiKey(config: ProviderConfig): string {
  if (config.type === 'ollama') return ''
  if (config.type === 'custom') return config.customApiKey
  return config.openrouterApiKey
}

export function getHeaders(config: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  // Ollama ignores Authorization, but sending an empty bearer token trips up
  // proxies people put in front of it, so omit the header when there is no key.
  const apiKey = getApiKey(config)
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  if (config.type === 'openrouter') {
    headers['HTTP-Referer'] = 'https://holmes.app'
    // Identifies the app to OpenRouter's dashboard. Not the assistant's
    // display name — renaming the assistant must not change attribution.
    headers['X-OpenRouter-Title'] = 'Holmes'
  }

  return headers
}

// OpenRouter's `reasoning: { effort }` extension is not part of the OpenAI
// schema. Ollama rejects unknown top-level body fields on some builds, so the
// knob is only sent where it is understood.
export function supportsReasoningEffort(config: ProviderConfig): boolean {
  return config.type !== 'ollama'
}

export function describeProvider(config: ProviderConfig): string {
  if (config.type === 'openrouter') return 'OpenRouter'
  if (config.type === 'ollama') return 'Ollama'
  return 'the configured provider'
}

export function missingCredentialsError(config: ProviderConfig): Error {
  return new Error(
    config.type === 'ollama'
      ? 'Ollama is not reachable. Start it with `ollama serve` and check the host in Settings.'
      : 'No API key configured'
  )
}
