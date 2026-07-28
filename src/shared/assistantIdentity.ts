// The assistant's display name is user-configurable, but it is baked into a lot
// of generated text: the identity system prompt, transcript speaker labels that
// end up inside contexts, memory evidence labels, the window title. Those call
// sites live in modules that must stay free of electron imports (several are
// loaded directly by the .mjs tests), so the live name is cached here rather
// than read from electron-store at each use. The main process owns the cache:
// it calls setAssistantName() at startup and whenever settings change. The
// renderer never sets it — it reads settings.assistantName from the store.

export const DEFAULT_ASSISTANT_NAME = 'Holmes'

const MAX_ASSISTANT_NAME_LENGTH = 40

export function normalizeAssistantName(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_ASSISTANT_NAME
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ASSISTANT_NAME_LENGTH)
  return cleaned || DEFAULT_ASSISTANT_NAME
}

let currentAssistantName = DEFAULT_ASSISTANT_NAME

export function setAssistantName(raw: unknown): string {
  currentAssistantName = normalizeAssistantName(raw)
  return currentAssistantName
}

export function getAssistantName(): string {
  return currentAssistantName
}

const NAME_TOKEN = /\{\{ASSISTANT_NAME\}\}/g
// Wraps prose that only makes sense while the assistant is still called Holmes
// (the "not imitating a fictional detective" disclaimer). Renaming drops it
// instead of producing 'The name "Watson" reflects careful reasoning'.
const DEFAULT_NAME_ONLY = /\{\{#if default-name\}\}([\s\S]*?)\{\{\/if\}\}/g

export function renderAssistantPrompt(template: string, name?: string): string {
  const resolved = normalizeAssistantName(name ?? currentAssistantName)
  return template
    .replace(DEFAULT_NAME_ONLY, (_match, body: string) =>
      resolved === DEFAULT_ASSISTANT_NAME ? body : ''
    )
    .replace(NAME_TOKEN, resolved)
}
