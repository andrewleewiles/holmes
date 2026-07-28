import { Preferences } from '@capacitor/preferences'

export interface PairedIdentity {
  deviceId: string
  host: string
  port: number
  serverStaticPub: string
  privateKey: string
  publicKey: string
}

const KEY = 'holmes.pairing'

/**
 * Where the device's long-term private key lives.
 *
 * NOT YET THE KEYCHAIN. @capacitor/preferences is UserDefaults on iOS, which is
 * readable from an unencrypted device backup. Before this ships, back this
 * module with a Keychain plugin (kSecClassGenericPassword,
 * kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly) and migrate any existing
 * value across. Nothing outside this file touches the key, so that change is
 * local to these three functions.
 */
export async function loadIdentity(): Promise<PairedIdentity | null> {
  const { value } = await Preferences.get({ key: KEY })
  if (!value) return null
  try {
    return JSON.parse(value) as PairedIdentity
  } catch {
    return null
  }
}

export async function saveIdentity(identity: PairedIdentity): Promise<void> {
  await Preferences.set({ key: KEY, value: JSON.stringify(identity) })
}

export async function clearIdentity(): Promise<void> {
  await Preferences.remove({ key: KEY })
}
