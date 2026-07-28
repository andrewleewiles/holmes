import { useSettingsStore } from '../store/settingsStore'

export function useSettings() {
  const {
    settings,
    models,
    showSettings,
    loadSettings,
    updateSettings,
    updateProvider,
    loadModels,
    toggleSettings,
    closeSettings,
    hasApiKey,
  } = useSettingsStore()

  return {
    settings,
    models,
    showSettings,
    loadSettings,
    updateSettings,
    updateProvider,
    loadModels,
    toggleSettings,
    closeSettings,
    hasApiKey,
  }
}
