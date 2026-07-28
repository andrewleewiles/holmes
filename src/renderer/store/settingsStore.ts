import { create } from 'zustand'
import type { AppSettings, ProviderConfig, ModelInfo } from '@shared/types'
import { hasProviderCredentials } from '@shared/providerConfig'

interface SettingsState {
  settings: AppSettings | null
  models: ModelInfo[]
  showSettings: boolean

  loadSettings: () => Promise<void>
  updateSettings: (partial: Partial<AppSettings>) => Promise<void>
  updateProvider: (config: ProviderConfig) => Promise<void>
  loadModels: () => Promise<void>
  toggleSettings: () => void
  closeSettings: () => void
  hasApiKey: () => boolean
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  models: [],
  showSettings: false,

  loadSettings: async () => {
    const settings = await window.electronAPI.settings.get()
    set({ settings })
  },

  updateSettings: async (partial: Partial<AppSettings>) => {
    await window.electronAPI.settings.set(partial)
    const settings = await window.electronAPI.settings.get()
    set({ settings })
  },

  updateProvider: async (config: ProviderConfig) => {
    await window.electronAPI.settings.setProvider(config)
    const settings = await window.electronAPI.settings.get()
    set({ settings })
  },

  loadModels: async () => {
    const models = await window.electronAPI.models.list()
    set({ models })
  },

  toggleSettings: () => set((s) => ({ showSettings: !s.showSettings })),
  closeSettings: () => set({ showSettings: false }),

  hasApiKey: () => {
    const { settings } = get()
    return hasProviderCredentials(settings?.provider)
  },
}))
