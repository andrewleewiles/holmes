import type { ContextVersionSourceType } from './types'

// Sentinels a context generator stores when a pass failed. They are not real
// analyses: they are never archived as a version and never treated as a cache hit.
export const FAILED_CONTEXT_PREFIXES = [
  'Empty or unreadable document:',
  'Context generation failed for',
  'No synthesis produced for',
  'Folder synthesis failed for',
  'Unified synthesis unavailable.',
]

export function isFailedContext(text: string): boolean {
  return FAILED_CONTEXT_PREFIXES.some((prefix) => text.startsWith(prefix))
}

export const CONTEXT_VERSION_LABELS: Record<ContextVersionSourceType, string> = {
  'document-file': 'File context',
  'document-folder': 'Folder super-context',
  conversation: 'Conversation context',
  'user-super-context': 'User super-context',
  'memory-summary': 'Memory summary',
  'health-analysis': 'Health analysis',
  'activity-analysis': 'Activity analysis',
  'finances-summary': 'Finances summary',
  'timeline-year': 'Year super-context',
  'person-dossier': 'Person dossier',
  'person-year': 'Person year',
  'session-note': 'Session note',
}

const MAX_SHORT_CHARS = 400

// The one-line gist stored alongside an archived version, so the timeline can
// show what changed without loading the whole context back.
export function deriveContextShort(context: string, explicitShort?: string): string {
  const short = (explicitShort ?? '').trim()
  if (short) return short.slice(0, MAX_SHORT_CHARS)
  const body = context.trim()
  if (!body) return ''
  const firstSentence = body.match(/^.*?[.!?](\s|$)/)?.[0]?.trim()
  return (firstSentence || body).slice(0, MAX_SHORT_CHARS)
}

// The title a timeline entry gets for an archived context version.
export function contextVersionTitle(sourceLabel: string, version: number): string {
  return version <= 1
    ? `${sourceLabel} — context first generated`
    : `${sourceLabel} — context updated (v${version})`
}
