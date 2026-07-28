import { useSettingsStore } from '../store/settingsStore'
import { DEFAULT_ASSISTANT_NAME, normalizeAssistantName } from '@shared/assistantIdentity'

export interface AssistantIdentity {
  name: string
  /** A PROJECT_ICON_REGISTRY key, a data: URL, or '' for the bundled symbol. */
  icon: string
}

/**
 * Reads the assistant's name and icon from settings. Falls back to the default
 * name while settings are still loading so nothing renders as an empty string.
 */
export function useAssistantIdentity(): AssistantIdentity {
  const settings = useSettingsStore((state) => state.settings)
  return {
    name: settings ? normalizeAssistantName(settings.assistantName) : DEFAULT_ASSISTANT_NAME,
    icon: settings?.assistantIcon?.trim() ?? '',
  }
}
