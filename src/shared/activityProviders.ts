/**
 * The Activity account registry.
 *
 * Activity is the one data source that reaches outside the machine. Every other
 * source is a folder; this one is a list of named accounts, each of which either
 * has a live path (a local database, an IMAP mailbox, a session cookie) or does
 * not, in which case the only way in is the export archive the service will mail
 * you on request.
 *
 * This file is the single source of truth for that list. The Data page renders
 * it, the ingest dispatcher switches on it, and the background timer iterates it
 * — nothing else enumerates providers. Adding an account is one entry here plus
 * one parser in `src/main/activityExports/`.
 *
 * `liveViability` is deliberately honest rather than aspirational. Most consumer
 * services have no read API for your own activity, and the ones that survive on
 * a session cookie do so at the mercy of the site's bot defenses. The UI shows
 * this verbatim so a connector that is going to break says so before it is used.
 */

export type ActivityProviderId =
  | 'amazon'
  | 'gmail'
  | 'google-search'
  | 'youtube'
  | 'tiktok'
  | 'facebook'
  | 'instagram'
  | 'snapchat'
  | 'discord'
  | 'linkedin'
  | 'imessage'
  | 'tinder'
  | 'bumble'

/** How (and whether) an account can be read without an export file. */
export type ActivityLiveMode =
  /** No live path exists. The export archive is the only way in. */
  | 'none'
  /** A database already on this Mac. Needs a TCC grant, never a network call. */
  | 'local-db'
  /** IMAP with an app password. */
  | 'imap'
  /** An authenticated web endpoint driven by pasted session cookies. */
  | 'cookie'

/**
 * How much to trust the live path. Shown to the user before they invest in
 * setting one up.
 */
export type ActivityLiveViability =
  /** Officially supported, or local. Expected to keep working. */
  | 'stable'
  /** Unofficial and bot-defended. Expect it to break without warning. */
  | 'brittle'
  /** Unofficial AND against the service's terms. Can cost you the account. */
  | 'ban-risk'
  /** There is no live path at all. */
  | 'none'

export type ActivityCredentialKind = 'none' | 'app-password' | 'cookie'

export type ActivityExportFormat =
  | 'none'
  /** Google Takeout: a folder (or zip) of per-service JSON/HTML. */
  | 'takeout'
  /** Meta "Download Your Information" JSON — note the mojibake quirk. */
  | 'meta-json'
  | 'json'
  | 'csv'
  | 'mbox'

/**
 * Which table an account's events land in. Where an existing typed table
 * genuinely fits the shape we reuse it; everything else goes to the generic
 * `account_events`.
 */
export type ActivityEventTable = 'account_events' | 'email_events' | 'youtube_events' | 'amazon_events'

export interface ActivityProviderDef {
  id: ActivityProviderId
  label: string
  /** Providers that render nested under a single heading on the Data page. */
  parent?: 'google'
  /** FontAwesome icon name; resolved to an IconDefinition in the renderer. */
  icon: string
  live: ActivityLiveMode
  liveViability: ActivityLiveViability
  /** Shown before connecting, whenever the live path is not `stable`. */
  liveWarning?: string
  credential: ActivityCredentialKind
  exportFormat: ActivityExportFormat
  /** Deep link to the service's request-your-data page. */
  exportUrl: string
  /** Inline instructions for getting the export. */
  exportSteps: string
  /** Roughly how long the service takes to deliver an export, for the UI. */
  exportEta?: string
  eventTable: ActivityEventTable
  /** One line on what this account actually contributes. */
  blurb: string
}

export const ACTIVITY_PROVIDERS: readonly ActivityProviderDef[] = [
  {
    id: 'imessage',
    label: 'iMessage',
    icon: 'comment',
    live: 'local-db',
    liveViability: 'stable',
    credential: 'none',
    exportFormat: 'none',
    exportUrl: '',
    exportSteps:
      'No export needed. Messages are read directly from ~/Library/Messages/chat.db, which requires Full Disk Access for Holmes.',
    eventTable: 'account_events',
    blurb:
      'Who you talk to, how often, and what was said. Message text is stored as a 500-character excerpt, redacted like every other field.',
  },
  {
    id: 'gmail',
    label: 'Gmail',
    parent: 'google',
    icon: 'envelope',
    live: 'imap',
    liveViability: 'stable',
    credential: 'app-password',
    exportFormat: 'mbox',
    exportUrl: 'https://takeout.google.com/',
    exportSteps:
      'Google Takeout → deselect all → select Mail → export. Produces a .mbox file. Live IMAP is the better path: enable 2-Step Verification, then create an app password at myaccount.google.com/apppasswords.',
    exportEta: 'minutes to hours',
    eventTable: 'email_events',
    blurb: 'Message envelopes — who, when, subject. Bodies are not fetched over IMAP.',
  },
  {
    id: 'google-search',
    label: 'Google Search history',
    parent: 'google',
    icon: 'magnifying-glass',
    live: 'none',
    liveViability: 'none',
    credential: 'none',
    exportFormat: 'takeout',
    exportUrl: 'https://takeout.google.com/',
    exportSteps:
      'Google Takeout → deselect all → select "My Activity" → export. HTML (the default) and JSON both work. Importing the whole Takeout folder here also picks up YouTube history and your Gmail mbox, so you only need to do it once. Takeout can deliver on a schedule (every 2 months for a year) — point it at a synced folder and set that as this account\'s watched folder.',
    exportEta: 'minutes to hours',
    eventTable: 'account_events',
    blurb: 'What you searched for and when. Google has never offered an API for My Activity.',
  },
  {
    id: 'youtube',
    label: 'YouTube',
    icon: 'play',
    live: 'none',
    liveViability: 'none',
    liveWarning:
      'The YouTube Data API can return your likes, subscriptions and playlists, but watch history has been inaccessible through it since 2016. Watch history is Takeout-only.',
    credential: 'none',
    exportFormat: 'takeout',
    exportUrl: 'https://takeout.google.com/',
    exportSteps:
      'Google Takeout → deselect all → select "YouTube and YouTube Music" → in the content options choose "history" → export. HTML (the default) and JSON both work. If you import the whole Takeout folder under any Google account, this one is filled in automatically.',
    exportEta: 'minutes to hours',
    eventTable: 'youtube_events',
    blurb: 'What you watched and when.',
  },
  {
    id: 'amazon',
    label: 'Amazon',
    icon: 'cart-shopping',
    live: 'cookie',
    liveViability: 'brittle',
    liveWarning:
      'Amazon has no consumer order API. This drives the same GraphQL endpoint the website uses, authenticated with your pasted session cookies. It stops working whenever the session expires and you will need to paste fresh cookies.',
    credential: 'cookie',
    exportFormat: 'csv',
    exportUrl: 'https://www.amazon.com/hz/privacy-central/data-requests/preview.html',
    exportSteps:
      'Amazon → Account → Data Privacy → Request Your Information → choose "Your Orders" (or Request All). Arrives as a link by email; the useful files are the order history CSVs.',
    exportEta: '1–30 days',
    eventTable: 'amazon_events',
    blurb: 'Orders, items and totals.',
  },
  {
    id: 'instagram',
    label: 'Instagram',
    icon: 'camera',
    live: 'cookie',
    liveViability: 'brittle',
    liveWarning:
      'The Basic Display API was shut down in December 2024 and its replacement only covers business/creator media. This uses the web endpoints behind your session cookies, which are bot-defended (signed headers, rate limits) and will break often.',
    credential: 'cookie',
    exportFormat: 'meta-json',
    exportUrl: 'https://accountscenter.instagram.com/info_and_permissions/dyi/',
    exportSteps:
      'Accounts Center → Your information and permissions → Download your information → select JSON (not HTML) → request. Arrives as a zip.',
    exportEta: 'hours to a few days',
    eventTable: 'account_events',
    blurb: 'Posts, likes, saved items, searches, DM metadata and ad interests.',
  },
  {
    id: 'facebook',
    label: 'Facebook',
    icon: 'thumbs-up',
    live: 'cookie',
    liveViability: 'brittle',
    liveWarning:
      'The Graph API lost the ability to read your own timeline in v2.x. This uses the web endpoints behind your session cookies and is expected to be fragile.',
    credential: 'cookie',
    exportFormat: 'meta-json',
    exportUrl: 'https://accountscenter.facebook.com/info_and_permissions/dyi/',
    exportSteps:
      'Accounts Center → Your information and permissions → Download your information → select JSON (not HTML) → request. Arrives as a zip.',
    exportEta: 'hours to a few days',
    eventTable: 'account_events',
    blurb: 'Posts, comments, reactions, groups, events and ad interests.',
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    icon: 'music',
    live: 'cookie',
    liveViability: 'brittle',
    liveWarning:
      'TikTok\'s Display API returns only your own posted videos, never your watch history. This drives the web endpoints behind your session cookies instead, which are aggressively bot-defended.',
    credential: 'cookie',
    exportFormat: 'json',
    exportUrl: 'https://www.tiktok.com/setting/download-your-data',
    exportSteps:
      'Settings and privacy → Account → Download your data → select JSON → request. Download it within 4 days of it being ready.',
    exportEta: 'up to 4 days',
    eventTable: 'account_events',
    blurb: 'Watch history, searches, likes, follows and DM metadata.',
  },
  {
    id: 'snapchat',
    label: 'Snapchat',
    icon: 'ghost',
    live: 'none',
    liveViability: 'none',
    liveWarning:
      'Snap\'s Login Kit returns your display name and Bitmoji and nothing else. There is no read path for your own activity.',
    credential: 'none',
    exportFormat: 'json',
    exportUrl: 'https://accounts.snapchat.com/accounts/downloadmydata',
    exportSteps:
      'accounts.snapchat.com → My Data → submit request. Arrives as a zip of per-category JSON files.',
    exportEta: 'up to 24 hours',
    eventTable: 'account_events',
    blurb: 'Snap and chat history metadata, friends, and location history.',
  },
  {
    id: 'discord',
    label: 'Discord',
    icon: 'hashtag',
    live: 'cookie',
    liveViability: 'ban-risk',
    liveWarning:
      'Discord has no read API for personal accounts. Driving the client API with your own user token is a Terms of Service violation and Discord does terminate accounts for it. This connector is disabled unless you explicitly accept that risk — the data export below carries none of it.',
    credential: 'cookie',
    exportFormat: 'csv',
    exportUrl: 'https://discord.com/app',
    exportSteps:
      'User Settings → Data & Privacy → Request all of my Data → include Messages. Arrives by email as a zip; messages are per-channel CSVs under messages/.',
    exportEta: 'up to 30 days',
    eventTable: 'account_events',
    blurb: 'Message metadata per channel, servers joined, and account activity.',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    icon: 'briefcase',
    live: 'cookie',
    liveViability: 'brittle',
    liveWarning:
      'LinkedIn\'s public API returns your name, email and photo and nothing more; the Member Data Portability API needs LinkedIn\'s approval outside the EU. This uses the web endpoints behind your session cookies, and LinkedIn actively blocks automated access.',
    credential: 'cookie',
    exportFormat: 'csv',
    exportUrl: 'https://www.linkedin.com/mypreferences/d/download-my-data',
    exportSteps:
      'Settings → Data privacy → Get a copy of your data → select the larger archive → request. Arrives as a zip of CSVs.',
    exportEta: '10 minutes to 24 hours',
    eventTable: 'account_events',
    blurb: 'Connections, messages metadata, searches, job applications and posts.',
  },
  {
    id: 'tinder',
    label: 'Tinder',
    icon: 'fire',
    live: 'none',
    liveViability: 'none',
    credential: 'none',
    exportFormat: 'json',
    exportUrl: 'https://account.gotinder.com/data',
    exportSteps:
      'account.gotinder.com/data → request your data. Arrives as a link by email; the archive contains data.json with matches, messages and per-day usage counts.',
    exportEta: '1–7 days',
    eventTable: 'account_events',
    blurb: 'Matches, message counts, swipe and open-app counts by day.',
  },
  {
    id: 'bumble',
    label: 'Bumble',
    icon: 'heart',
    live: 'none',
    liveViability: 'none',
    credential: 'none',
    exportFormat: 'json',
    exportUrl: 'https://bumble.com/en/help/contact',
    exportSteps:
      'In the app: Settings → Contact & FAQ → request your data (or email a data request via the help page). The archive is the least structured of the dating exports — Holmes parses what it can find.',
    exportEta: '1–30 days',
    eventTable: 'account_events',
    blurb: 'Matches, message metadata and account history.',
  },
] as const

const PROVIDER_BY_ID = new Map<string, ActivityProviderDef>(ACTIVITY_PROVIDERS.map((p) => [p.id, p]))

export function isActivityProviderId(value: unknown): value is ActivityProviderId {
  return typeof value === 'string' && PROVIDER_BY_ID.has(value)
}

export function activityProvider(id: ActivityProviderId): ActivityProviderDef {
  const def = PROVIDER_BY_ID.get(id)
  if (!def) throw new Error(`Unknown activity provider: ${id}`)
  return def
}

/** Undefined for a provider with no live path. */
export function activityProviderOrNull(id: string): ActivityProviderDef | null {
  return PROVIDER_BY_ID.get(id) ?? null
}

export function hasLivePath(def: ActivityProviderDef): boolean {
  return def.live !== 'none'
}

/** A live path the user has to be warned about before using. */
export function livePathNeedsConsent(def: ActivityProviderDef): boolean {
  return def.liveViability === 'ban-risk'
}

/**
 * The Data page groups Gmail and Search history under one "Google" heading and
 * renders everything else flat.
 */
export const ACTIVITY_PROVIDER_GROUPS: ReadonlyArray<{
  key: 'google' | 'flat'
  label: string
  providers: readonly ActivityProviderDef[]
}> = [
  {
    key: 'google',
    label: 'Google',
    providers: ACTIVITY_PROVIDERS.filter((p) => p.parent === 'google'),
  },
  {
    key: 'flat',
    label: '',
    providers: ACTIVITY_PROVIDERS.filter((p) => !p.parent),
  },
]
