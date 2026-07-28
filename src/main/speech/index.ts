// The narration provider registry.
//
// One place that knows which services exist, so adding a third means adding a
// file and one line here rather than touching the generator, the IPC layer and
// the call logger.
import type { SpeechProviderId } from '../../shared/types'
import type { SpeechProvider } from './types'
import { elevenLabsProvider } from './elevenlabs'
import { speechifyProvider } from './speechify'

export const SPEECH_PROVIDERS: readonly SpeechProvider[] = [elevenLabsProvider, speechifyProvider] as const

export const DEFAULT_SPEECH_PROVIDER: SpeechProviderId = 'elevenlabs'

export function getSpeechProvider(id: string): SpeechProvider {
  const provider = SPEECH_PROVIDERS.find((entry) => entry.id === id)
  if (!provider) throw new Error(`Unknown narration provider: ${id}`)
  return provider
}

export function isSpeechProviderId(value: unknown): value is SpeechProviderId {
  return typeof value === 'string' && SPEECH_PROVIDERS.some((entry) => entry.id === value)
}

/** Every service's base URL, for the call logger to recognise its traffic. */
export function speechBaseUrls(): Array<{ id: SpeechProviderId; baseUrl: string }> {
  return SPEECH_PROVIDERS.map((provider) => ({ id: provider.id, baseUrl: provider.baseUrl }))
}

export type { SpeechProvider } from './types'
export { SpeechError } from './types'
