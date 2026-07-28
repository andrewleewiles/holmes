import { IPC } from '../main/ipcChannels'
import type { ModelTier, ModelTierConfig, ReasoningEffort } from './types'

export const REMOTE_PROTOCOL_VERSION = 1
export const REMOTE_DEFAULT_PORT = 8787
export const REMOTE_WS_PATH = '/holmes'
export const REMOTE_PAIRING_CODE_TTL_MS = 5 * 60 * 1000
export const REMOTE_PAIRING_CODE_LENGTH = 8
export const REMOTE_MAX_FRAME_BYTES = 8 * 1024 * 1024
export const REMOTE_HEARTBEAT_MS = 20_000

export type RemoteErrorCode =
  | 'protocol-version'
  | 'bad-frame'
  | 'unknown-device'
  | 'bad-pairing-code'
  | 'pairing-closed'
  | 'not-authenticated'
  | 'channel-denied'
  | 'handler-error'
  | 'too-large'

export interface RemotePairFrame {
  t: 'pair'
  v: number
  code: string
  clientStaticPub: string
  deviceName: string
  platform: string
}

export interface RemotePairedFrame {
  t: 'paired'
  deviceId: string
  serverStaticPub: string
}

export interface RemoteHelloFrame {
  t: 'hello'
  v: number
  deviceId: string
  clientEphemeralPub: string
}

export interface RemoteHelloOkFrame {
  t: 'hello-ok'
  serverEphemeralPub: string
}

export interface RemoteErrorFrame {
  t: 'error'
  code: RemoteErrorCode
  message: string
}

export interface RemoteSealedFrame {
  t: 'msg'
  n: number
  d: string
}

export type RemoteFrame =
  | RemotePairFrame
  | RemotePairedFrame
  | RemoteHelloFrame
  | RemoteHelloOkFrame
  | RemoteErrorFrame
  | RemoteSealedFrame

export interface RemoteRequest {
  k: 'req'
  id: number
  channel: string
  args: unknown[]
}

export interface RemoteResponseOk {
  k: 'res'
  id: number
  ok: true
  result: unknown
}

export interface RemoteResponseErr {
  k: 'res'
  id: number
  ok: false
  error: string
  code?: RemoteErrorCode
}

export interface RemoteEvent {
  k: 'evt'
  channel: string
  args: unknown[]
}

export interface RemotePing {
  k: 'ping'
}

export interface RemotePong {
  k: 'pong'
}

export type RemoteMessage =
  | RemoteRequest
  | RemoteResponseOk
  | RemoteResponseErr
  | RemoteEvent
  | RemotePing
  | RemotePong

export interface RemoteDevice {
  id: string
  name: string
  platform: string
  publicKey: string
  createdAt: number
  lastSeenAt: number | null
}

export interface RemotePairingOffer {
  code: string
  expiresAt: number
  host: string
  port: number
  serverStaticPub: string
}

export interface RemoteServerStatus {
  enabled: boolean
  listening: boolean
  port: number
  host: string | null
  error: string | null
  connectedDeviceIds: string[]
  pairing: RemotePairingOffer | null
}

/**
 * The subset of AppSettings a paired phone may read. `settings:get` returns the
 * provider API key, the web-search key and the file access scope, so it is not
 * remote-callable and this stands in for it.
 */
export interface RemoteClientSettings {
  assistantName: string
  assistantIcon: string
  welcomeLines: string[]
  theme: 'light' | 'dark' | 'system'
  defaultModel: string
  defaultEffort: ReasoningEffort
  modelTiers: ModelTierConfig
  defaultTier: ModelTier
  timelineEnabled: boolean
  peopleEnabled: boolean
  documentContextEnabled: boolean
  automationPaused: boolean
  hasProvider: boolean
}

/**
 * Every channel a paired device may invoke. Absent means denied — see
 * docs/ios-app.md. Nothing that writes to the filesystem, changes the file
 * access scope, reads or sets credentials, spawns a sidecar, or starts a paid
 * bulk run belongs in this set.
 */
export const REMOTE_CALLABLE_CHANNELS: ReadonlySet<string> = new Set<string>([
  IPC.REMOTE.CLIENT_SETTINGS,

  IPC.CONVERSATIONS.LIST,
  IPC.CONVERSATIONS.CREATE,
  IPC.CONVERSATIONS.DELETE,
  IPC.CONVERSATIONS.RENAME,
  IPC.CONVERSATIONS.UPDATE_MODEL,
  IPC.CONVERSATIONS.UPDATE_EFFORT,
  IPC.CONVERSATIONS.UPDATE_MEMORY_MODE,
  IPC.CONVERSATIONS.UPDATE_CONTEXT,
  IPC.CONVERSATIONS.UPDATE_ROLE,
  IPC.CONVERSATIONS.UPDATE_SYSTEM_PROMPT,
  IPC.CONVERSATIONS.GET_MESSAGES,
  IPC.CONVERSATIONS.SEARCH,

  IPC.CHAT.SEND,
  IPC.CHAT.EDIT_MESSAGE,
  IPC.CHAT.RETRY_MESSAGE,
  IPC.CHAT.SET_ACTIVE_BRANCH,
  IPC.CHAT.ABORT,
  IPC.CHAT.PREVIEW_SYSTEM_PROMPT,

  IPC.MODELS.LIST,

  IPC.RECALL.SEARCH,
  IPC.RECALL.ABORT,
  IPC.RECALL.CLEAR,
  IPC.RECALL.START_CONVERSATION,

  IPC.MEMORY.LIST,
  IPC.MEMORY.GET,
  IPC.MEMORY.SUGGESTIONS,

  IPC.PROJECTS.LIST,
  IPC.PROJECTS.LIST_SOURCES,

  IPC.HEALTH.LIST_RECORDS,
  IPC.HEALTH.LIST_OBSERVATIONS,
  IPC.HEALTH.GET_SUMMARY,
  IPC.HEALTH.LIVE_STATUS,

  IPC.ACTIVITY.LIST_RECORDS,
  IPC.ACTIVITY.LIST_EVENTS,
  IPC.ACTIVITY.GET_SUMMARY,
  IPC.ACTIVITY.GET_RUN_STATE,
  IPC.ACTIVITY.LIVE_STATUS,

  IPC.DOCUMENTS.GET_STATE,
  IPC.DOCUMENTS.GET_TREE,
  IPC.DOCUMENTS.GET_SUMMARIES,
  IPC.DOCUMENTS.GET_PROVENANCE,
  IPC.DOCUMENTS.GET_USER_CONTEXT,

  IPC.TIMELINE.LIST,
  IPC.TIMELINE.GET_SUMMARY,
  IPC.TIMELINE.GET_YEARS,
  IPC.TIMELINE.GET_STATE,

  IPC.PEOPLE.LIST,
  IPC.PEOPLE.GET,
  IPC.PEOPLE.GET_STATE,

  IPC.CONTEXT_VERSIONS.LIST,
  IPC.CONTEXT_VERSIONS.GET,

  IPC.ROLES.LIST,
  IPC.ROLES.GET_SESSION_NOTE,
  IPC.ROLES.LIST_SESSION_NOTES,

  IPC.LIBRARY.LIST_BOOKS,
  IPC.LIBRARY.GET_STATE,

  IPC.PROVIDER_CREDIT.GET,

  IPC.CALL_HISTORY.LIST,
  IPC.CALL_HISTORY.STATS,
])

/** Broadcast channels forwarded to connected devices. */
export const REMOTE_EVENT_CHANNELS: ReadonlySet<string> = new Set<string>([
  IPC.CHAT.STREAM_CHUNK,
  IPC.CHAT.STREAM_DONE,
  IPC.CHAT.STREAM_ERROR,
  IPC.CHAT.SYSTEM_PROMPT,
  IPC.CONVERSATIONS.UPDATED,
  IPC.DOCUMENTS.STATE,
  IPC.ACTIVITY.RUN_STATE,
  IPC.TIMELINE.STATE,
  IPC.PEOPLE.STATE,
  IPC.LIBRARY.STATE,
  IPC.PROVIDER_CREDIT.STATE,
  IPC.ROLES.SESSION_NOTE_ADDED,
])

export function isRemoteCallable(channel: string): boolean {
  return REMOTE_CALLABLE_CHANNELS.has(channel)
}

export function isRemoteEvent(channel: string): boolean {
  return REMOTE_EVENT_CHANNELS.has(channel)
}

/**
 * ATS cannot except a bare IP, so a cleartext socket may only be opened to a
 * MagicDNS or .local name. Pairing to `100.x.y.z` would force
 * NSAllowsArbitraryLoads across the whole app — see docs/ios-app.md.
 */
export function isAllowedRemoteHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase()
  if (!trimmed) return false
  if (/^[0-9.]+$/.test(trimmed)) return false
  if (/^\[?[0-9a-f:]+\]?$/.test(trimmed) && trimmed.includes(':')) return false
  return trimmed.endsWith('.ts.net') || trimmed.endsWith('.local') || !trimmed.includes('.')
}

export function normalizePairingCode(raw: string): string {
  return raw.replace(/[^0-9a-z]/gi, '').toUpperCase()
}
