import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCirclePlay, faKey, faXmark } from '@fortawesome/free-solid-svg-icons'
import type {
  AudiobookEstimate,
  BookChapter,
  SpeechModel,
  SpeechProviderId,
  SpeechProviderInfo,
  SpeechVoice,
} from '@shared/types'

interface NarrationDialogProps {
  bookId: string
  chapters: BookChapter[]
  currentChapter: number
  busy: boolean
  error: string | null
  onGenerate: (
    chapterIndex: number,
    providerId: SpeechProviderId,
    voice: SpeechVoice,
    modelId: string,
    force: boolean
  ) => void
  onClose: () => void
}

function cleanError(error: unknown): string {
  if (!(error instanceof Error)) return 'Something went wrong'
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

function minutes(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins} min`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

export const NarrationDialog: FC<NarrationDialogProps> = ({
  bookId,
  chapters,
  currentChapter,
  busy,
  error,
  onGenerate,
  onClose,
}) => {
  const [providers, setProviders] = useState<SpeechProviderInfo[]>([])
  const [providerId, setProviderId] = useState<SpeechProviderId | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyMessage, setKeyMessage] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState(false)
  const [voices, setVoices] = useState<SpeechVoice[]>([])
  const [models, setModels] = useState<SpeechModel[]>([])
  const [voiceId, setVoiceId] = useState('')
  const [modelId, setModelId] = useState('')
  const [chapterIndex, setChapterIndex] = useState(currentChapter)
  const [estimate, setEstimate] = useState<AudiobookEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [loadingVoices, setLoadingVoices] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const loadProviders = useCallback(async () => {
    try {
      const list = await window.electronAPI.library.speechProviders()
      setProviders(list)
      // Land on a connected service if there is one, so the common case is one
      // click rather than a choice.
      setProviderId((current) => current ?? (list.find((entry) => entry.configured)?.id ?? list[0]?.id ?? null))
    } catch (err) {
      setLocalError(cleanError(err))
    }
  }, [])

  useEffect(() => { void loadProviders() }, [loadProviders])

  const active = useMemo(
    () => providers.find((entry) => entry.id === providerId) ?? null,
    [providers, providerId]
  )

  // Voices and models belong to the service, so both reload when it changes.
  useEffect(() => {
    if (!providerId || !active?.configured) { setVoices([]); setModels([]); return }
    let cancelled = false
    setLoadingVoices(true)
    Promise.all([
      window.electronAPI.library.listVoices(providerId),
      window.electronAPI.library.listNarrationModels(providerId),
    ])
      .then(([voiceList, modelList]) => {
        if (cancelled) return
        setVoices(voiceList)
        setModels(modelList)
        setVoiceId(voiceList[0]?.voiceId ?? '')
        setModelId(modelList[0]?.modelId ?? '')
        setLocalError(null)
      })
      .catch((err) => { if (!cancelled) setLocalError(cleanError(err)) })
      .finally(() => { if (!cancelled) setLoadingVoices(false) })
    return () => { cancelled = true }
  }, [providerId, active?.configured])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // A changed chapter, service or model means the previous quote was for
  // different work.
  useEffect(() => { setEstimate(null) }, [chapterIndex, modelId, providerId])

  const selectedVoice = useMemo(
    () => voices.find((voice) => voice.voiceId === voiceId) ?? null,
    [voices, voiceId]
  )

  const handleSaveKey = async () => {
    if (!providerId) return
    setSavingKey(true)
    setKeyMessage(null)
    try {
      const result = await window.electronAPI.library.setSpeechKey(providerId, keyDraft)
      setKeyMessage(result.message)
      if (result.ok) {
        setKeyDraft('')
        await loadProviders()
      }
    } catch (err) {
      setKeyMessage(cleanError(err))
    } finally {
      setSavingKey(false)
    }
  }

  const runEstimate = async () => {
    if (!providerId) return
    setEstimating(true)
    setLocalError(null)
    try {
      setEstimate(await window.electronAPI.library.estimateAudiobook(bookId, chapterIndex, providerId, modelId))
    } catch (err) {
      setLocalError(cleanError(err))
    } finally {
      setEstimating(false)
    }
  }

  const remaining = active?.quota ? active.quota.characterLimit - active.quota.characterCount : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onMouseDown={onClose}>
      <div
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-holmes-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
          <h2 className="font-serif-display text-[17px] text-white/85">Generate narration</h2>
          <button onClick={onClose} className="ml-auto cursor-pointer text-white/30 hover:text-white/70">
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto scrollbar-thin px-4 py-3">
          <div>
            <label className="mb-1 block text-[9px] uppercase tracking-wider text-white/30">Service</label>
            <div className="flex gap-1.5">
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  onClick={() => { setProviderId(provider.id); setKeyMessage(null) }}
                  className={`flex-1 cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors ${
                    providerId === provider.id
                      ? 'border-holmes-primary/35 bg-holmes-primary/[0.08]'
                      : 'border-white/[0.06] bg-white/[0.02] hover:border-white/15'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${provider.configured ? 'bg-emerald-400/80' : 'bg-white/20'}`}
                    />
                    <span className="text-[12px] text-white/80">{provider.label}</span>
                  </div>
                  <div className="text-[9px] text-white/30">
                    {provider.configured ? 'Connected' : 'No key yet'}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {!active ? null : !active.configured ? (
            <>
              <p className="text-[11px] leading-relaxed text-white/45">
                Paste a {active.label} API key to enable narration — it is stored in your system keychain, not in the
                app's settings file. <span className="text-white/30">({active.keyHint})</span>
              </p>
              <div className="flex items-center gap-2">
                <FontAwesomeIcon icon={faKey} className="text-[11px] text-white/25" />
                <input
                  type="password"
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  placeholder={active.keyHint}
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[12px] text-white/75 outline-none placeholder:text-white/20 focus:border-holmes-primary/35"
                />
                <button
                  onClick={() => void handleSaveKey()}
                  disabled={savingKey || !keyDraft.trim()}
                  className="cursor-pointer rounded-lg bg-holmes-primary px-3 py-2 text-xs font-medium text-white hover:bg-holmes-primary-light disabled:opacity-40"
                >
                  {savingKey ? 'Checking…' : 'Connect'}
                </button>
              </div>
              {keyMessage && <p className="text-[10px] text-white/50">{keyMessage}</p>}
              <button
                onClick={() => void window.electronAPI.app.openExternal(active.keyUrl)}
                className="cursor-pointer text-[10px] text-holmes-primary-light/70 underline underline-offset-2 hover:text-holmes-primary-light"
              >
                Where to find your {active.label} key
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-[10px] text-white/35">
                {active.quota ? (
                  <span className="tabular-nums">
                    {remaining?.toLocaleString()} of {active.quota.characterLimit.toLocaleString()} characters left
                  </span>
                ) : (
                  // Speechify publishes no allowance endpoint, so this says so
                  // rather than showing a number that might be wrong.
                  <span>Allowance not reported by {active.label}</span>
                )}
                <button
                  onClick={async () => {
                    await window.electronAPI.library.clearSpeechKey(active.id)
                    await loadProviders()
                  }}
                  className="ml-auto cursor-pointer underline underline-offset-2 hover:text-white/60"
                >
                  Disconnect
                </button>
              </div>

              <div>
                <label className="mb-1 block text-[9px] uppercase tracking-wider text-white/30">Chapter</label>
                <select
                  value={chapterIndex}
                  onChange={(event) => setChapterIndex(Number(event.target.value))}
                  className="w-full cursor-pointer rounded-md border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] text-white/70 outline-none"
                >
                  {chapters.map((chapter) => (
                    <option key={chapter.spineIndex} value={chapter.spineIndex}>
                      {chapter.title} — {chapter.wordCount.toLocaleString()} words
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-[9px] uppercase tracking-wider text-white/30">Voice</label>
                <div className="flex items-center gap-2">
                  <select
                    value={voiceId}
                    onChange={(event) => setVoiceId(event.target.value)}
                    disabled={loadingVoices || voices.length === 0}
                    className="min-w-0 flex-1 cursor-pointer rounded-md border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] text-white/70 outline-none disabled:opacity-40"
                  >
                    {loadingVoices && <option>Loading voices…</option>}
                    {voices.map((voice) => (
                      <option key={voice.voiceId} value={voice.voiceId}>
                        {voice.name}
                        {voice.labels.accent ? ` · ${voice.labels.accent}` : ''}
                        {voice.labels.locale ? ` · ${voice.labels.locale}` : ''}
                        {voice.labels.gender ? ` · ${voice.labels.gender}` : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      // Previews are hosted by the service, which the CSP's
                      // media-src does not allow — so it opens in the browser.
                      if (selectedVoice?.previewUrl) void window.electronAPI.app.openExternal(selectedVoice.previewUrl)
                    }}
                    disabled={!selectedVoice?.previewUrl}
                    title="Hear this voice (opens in your browser)"
                    className="shrink-0 cursor-pointer rounded-md border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[10px] text-white/50 hover:text-white/80 disabled:opacity-30"
                  >
                    <FontAwesomeIcon icon={faCirclePlay} />
                  </button>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[9px] uppercase tracking-wider text-white/30">Model</label>
                <div className="space-y-1">
                  {models.map((model) => (
                    <button
                      key={model.modelId}
                      onClick={() => setModelId(model.modelId)}
                      className={`block w-full cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors ${
                        modelId === model.modelId
                          ? 'border-holmes-primary/35 bg-holmes-primary/[0.08]'
                          : 'border-white/[0.06] bg-white/[0.02] hover:border-white/15'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] text-white/80">{model.name}</span>
                        <span className="text-[9px] tabular-nums text-white/30">
                          {model.costMultiplier === 1 ? 'standard credits' : `${model.costMultiplier}× credits`}
                        </span>
                        {!model.canStitch && (
                          <span
                            className="text-[9px] text-white/25"
                            title="Long chapters are split; this model cannot carry prosody across a split"
                          >
                            no stitching
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] leading-snug text-white/35">{model.description}</div>
                    </button>
                  ))}
                </div>
              </div>

              {estimate && (
                <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[10px] leading-relaxed text-white/50">
                  <div className="tabular-nums">
                    {estimate.characterCount.toLocaleString()} characters · {estimate.segmentCount} request
                    {estimate.segmentCount === 1 ? '' : 's'} · about {minutes(estimate.estimatedSeconds)} of audio
                  </div>
                  {estimate.quota === null && (
                    <div className="mt-1 text-white/35">
                      {active.label} does not report an allowance, so this may not fit in what is left.
                    </div>
                  )}
                  {estimate.exceedsQuota && (
                    <div className="mt-1 text-amber-200/80">
                      That is more than the {remaining?.toLocaleString()} characters left on your plan.
                    </div>
                  )}
                  {estimate.alreadyGenerated && (
                    <div className="mt-1 text-white/40">
                      This chapter is already narrated with these settings — generating again re-spends the characters.
                    </div>
                  )}
                </div>
              )}

              {(error || localError) && (
                <p className="text-[10px] leading-relaxed text-red-200/75">{error ?? localError}</p>
              )}
            </>
          )}
        </div>

        {active?.configured && (
          <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-3">
            <button
              onClick={() => void runEstimate()}
              disabled={estimating || busy}
              className="cursor-pointer rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/50 hover:border-white/20 hover:text-white/75 disabled:opacity-40"
            >
              {estimating ? 'Checking…' : 'Check length'}
            </button>
            <button
              onClick={() => {
                if (!selectedVoice || !providerId) return
                onGenerate(chapterIndex, providerId, selectedVoice, modelId, Boolean(estimate?.alreadyGenerated))
              }}
              disabled={busy || !selectedVoice || !modelId}
              className="ml-auto cursor-pointer rounded-lg bg-holmes-primary px-3 py-2 text-xs font-medium text-white hover:bg-holmes-primary-light disabled:opacity-40"
            >
              {busy ? 'Narrating…' : 'Generate'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
