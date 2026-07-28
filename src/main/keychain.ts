import keytar from 'keytar'
import type { ActivityCredentialKind, ActivityProviderId } from '../shared/types'

const SERVICE = 'holmes'

/** The single-account key this module used before the account registry. */
const LEGACY_AMAZON_ACCOUNT = 'amazon-cookies'

/**
 * Every Activity account's secret is stored under `${provider}:${kind}`, so a
 * provider can hold more than one kind of credential without a second service
 * entry. Nothing outside this module builds that string.
 */
function secretAccount(provider: ActivityProviderId, kind: ActivityCredentialKind): string {
  return `${provider}:${kind}`
}

export async function setSecret(
  provider: ActivityProviderId,
  kind: ActivityCredentialKind,
  secret: string
): Promise<void> {
  await keytar.setPassword(SERVICE, secretAccount(provider, kind), secret)
}

export async function getSecret(
  provider: ActivityProviderId,
  kind: ActivityCredentialKind
): Promise<string | null> {
  return await keytar.getPassword(SERVICE, secretAccount(provider, kind))
}

export async function clearSecret(
  provider: ActivityProviderId,
  kind: ActivityCredentialKind
): Promise<void> {
  try {
    await keytar.deletePassword(SERVICE, secretAccount(provider, kind))
  } catch {
    // Deleting a secret that was never stored is not an error.
  }
}

/**
 * Amazon cookies predate the registry and lived under a bare `amazon-cookies`
 * key. Move them to `amazon:cookie` so the generic path finds them, and only
 * drop the old key once the new one is readable — a half-finished migration
 * that loses the session would make the user re-paste their cookies.
 */
export async function migrateLegacySecrets(): Promise<void> {
  try {
    const legacy = await keytar.getPassword(SERVICE, LEGACY_AMAZON_ACCOUNT)
    if (!legacy) return

    const existing = await getSecret('amazon', 'cookie')
    if (!existing) {
      await setSecret('amazon', 'cookie', legacy)
      const verify = await getSecret('amazon', 'cookie')
      if (verify !== legacy) return
    }

    await keytar.deletePassword(SERVICE, LEGACY_AMAZON_ACCOUNT)
  } catch (err) {
    console.error('Keychain: legacy Amazon cookie migration failed', err)
  }
}

// Kept so the existing Amazon sync and its IPC handlers keep working unchanged.
export async function setAmazonCookies(cookies: string): Promise<void> {
  await setSecret('amazon', 'cookie', cookies)
}

export async function getAmazonCookies(): Promise<string | null> {
  return await getSecret('amazon', 'cookie')
}

export async function clearAmazonCookies(): Promise<void> {
  await clearSecret('amazon', 'cookie')
}

/**
 * Narration keys are not Activity providers, so they get their own accounts
 * rather than being forced into the `${provider}:${kind}` shape. They live in
 * the keychain for the same reason the others do: they are bearer credentials
 * that bill money, and electron-store is a plaintext JSON file.
 *
 * One entry per service, so connecting Speechify never disturbs an ElevenLabs
 * key that is already working.
 */
function speechAccount(provider: string): string {
  return `speech:${provider}`
}

export async function setSpeechKey(provider: string, key: string): Promise<void> {
  await keytar.setPassword(SERVICE, speechAccount(provider), key)
}

export async function getSpeechKey(provider: string): Promise<string | null> {
  return await keytar.getPassword(SERVICE, speechAccount(provider))
}

export async function clearSpeechKey(provider: string): Promise<void> {
  try {
    await keytar.deletePassword(SERVICE, speechAccount(provider))
  } catch {
    // Deleting a key that was never stored is not an error.
  }
}

/**
 * The first narration key predates the multi-service layout and lived under
 * `elevenlabs:api-key`. Moved on read, and the old entry only dropped once the
 * new one reads back — a half-finished migration would silently disconnect a
 * working key.
 */
const LEGACY_ELEVENLABS_ACCOUNT = 'elevenlabs:api-key'

export async function migrateLegacySpeechKey(): Promise<void> {
  try {
    const legacy = await keytar.getPassword(SERVICE, LEGACY_ELEVENLABS_ACCOUNT)
    if (!legacy) return
    const existing = await getSpeechKey('elevenlabs')
    if (!existing) {
      await setSpeechKey('elevenlabs', legacy)
      if ((await getSpeechKey('elevenlabs')) !== legacy) return
    }
    await keytar.deletePassword(SERVICE, LEGACY_ELEVENLABS_ACCOUNT)
  } catch (err) {
    console.error('Keychain: narration key migration failed', err)
  }
}
