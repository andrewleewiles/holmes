import { type FC, useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faArrowUpRightFromSquare,
  faAward,
  faBagShopping,
  faBoxOpen,
  faBuilding,
  faCircleCheck,
  faGlobe,
  faMagnifyingGlass,
  faSliders,
  faSpinner,
  faTag,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons'
import type {
  ModelInfo,
  ProductAvailability,
  ProductSearchPriorities,
  ProductSearchResult,
  ProviderType,
  ReasoningEffort,
} from '@shared/types'
import { ModelSelector } from './ModelSelector'
import { useAssistantIdentity } from '../hooks/useAssistantIdentity'

interface ProductSearchPageProps {
  models: ModelInfo[]
  selectedModel: string
  selectedEffort: ReasoningEffort
  providerType: ProviderType
  onModelChange: (model: string) => void
  onEffortChange: (effort: ReasoningEffort) => void
  onOpenExternal: (url: string) => Promise<void>
}

const PRIORITY_OPTIONS = [
  {
    key: 'price',
    label: 'Price',
    description: 'Lower purchase and ownership cost',
    icon: faTag,
    defaultWeight: 80,
  },
  {
    key: 'quality',
    label: 'Quality',
    description: 'Durability, reliability, and performance',
    icon: faAward,
    defaultWeight: 90,
  },
  {
    key: 'brand',
    label: 'Brand',
    description: 'Reputation, warranty, and support',
    icon: faBuilding,
    defaultWeight: 45,
  },
  {
    key: 'availability',
    label: 'Availability',
    description: 'In stock and purchasable now',
    icon: faBoxOpen,
    defaultWeight: 60,
  },
] as const

const AVAILABILITY: Record<ProductAvailability, { label: string; className: string }> = {
  in_stock: { label: 'In stock', className: 'bg-emerald-400/10 text-emerald-200/75 border-emerald-400/20' },
  limited: { label: 'Limited stock', className: 'bg-amber-400/10 text-amber-100/75 border-amber-400/20' },
  preorder: { label: 'Preorder', className: 'bg-blue-400/10 text-blue-100/75 border-blue-400/20' },
  out_of_stock: { label: 'Out of stock', className: 'bg-red-400/10 text-red-200/70 border-red-400/20' },
  unknown: { label: 'Check availability', className: 'bg-white/5 text-white/40 border-white/10' },
}

const INITIAL_PRIORITIES: ProductSearchPriorities = {
  price: 80,
  quality: 90,
  brand: 45,
  availability: 60,
}

const MISSING_PRODUCT_SEARCH_BRIDGE =
  'Product Search is not loaded in the current Electron session. Fully quit and reopen Holmes to load the updated preload bridge.'

interface CachedProductSearchState {
  query: string
  priorities: ProductSearchPriorities
  budget: string
  currency: string
  market: string
  notes: string
  result: ProductSearchResult | null
}

let cachedProductSearchState: CachedProductSearchState = {
  query: '',
  priorities: { ...INITIAL_PRIORITIES },
  budget: '',
  currency: 'USD',
  market: '',
  notes: '',
  result: null,
}

function readableError(error: unknown): string {
  if (!(error instanceof Error)) return 'Product research failed'
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export const ProductSearchPage: FC<ProductSearchPageProps> = ({
  models,
  selectedModel,
  selectedEffort,
  providerType,
  onModelChange,
  onEffortChange,
  onOpenExternal,
}) => {
  const { name: assistantName } = useAssistantIdentity()
  const [query, setQuery] = useState(cachedProductSearchState.query)
  const [priorities, setPriorities] = useState<ProductSearchPriorities>({ ...cachedProductSearchState.priorities })
  const [budget, setBudget] = useState(cachedProductSearchState.budget)
  const [currency, setCurrency] = useState(cachedProductSearchState.currency)
  const [market, setMarket] = useState(cachedProductSearchState.market)
  const [notes, setNotes] = useState(cachedProductSearchState.notes)
  const [searching, setSearching] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ProductSearchResult | null>(cachedProductSearchState.result)
  const searchingRef = useRef(false)
  const cancelRequestedRef = useRef(false)

  useEffect(() => () => {
    const productSearch = window.electronAPI.productSearch
    if (searchingRef.current && productSearch) void productSearch.abort()
  }, [])

  useEffect(() => {
    cachedProductSearchState = {
      query,
      priorities: { ...priorities },
      budget,
      currency,
      market,
      notes,
      result,
    }
  }, [query, priorities, budget, currency, market, notes, result])

  const researchModels = models.filter((model) => {
    if (!model.supportedParameters?.length) return true
    return model.supportedParameters.includes('structured_outputs') || model.supportedParameters.includes('response_format')
  })
  const selectedModelCompatible = researchModels.some((model) => model.id === selectedModel)

  const togglePriority = (key: keyof ProductSearchPriorities, defaultWeight: number) => {
    setPriorities((current) => ({
      ...current,
      [key]: current[key] === 0 ? defaultWeight : 0,
    }))
  }

  const search = async () => {
    const trimmedQuery = query.trim()
    if (!trimmedQuery || !selectedModel || searching) return
    const productSearch = window.electronAPI.productSearch
    if (!productSearch) {
      setError(MISSING_PRODUCT_SEARCH_BRIDGE)
      return
    }
    if (providerType !== 'openrouter') {
      setError('Web-grounded Product Search currently requires OpenRouter. Select it in Settings.')
      return
    }
    if (!Object.values(priorities).some((weight) => weight > 0)) {
      setError('Enable at least one ranking priority.')
      return
    }
    if (!selectedModelCompatible) {
      setError('Choose a model that supports structured outputs before searching.')
      return
    }

    const parsedBudget = budget.trim() ? Number(budget) : null
    if (parsedBudget !== null && (!Number.isFinite(parsedBudget) || parsedBudget <= 0)) {
      setError('Enter a valid maximum budget or leave it blank.')
      return
    }

    setSearching(true)
    searchingRef.current = true
    cancelRequestedRef.current = false
    setCancelling(false)
    setError(null)
    setResult(null)

    try {
      const research = await productSearch.search({
        query: trimmedQuery,
        priorities,
        ...(parsedBudget !== null ? { budget: { amount: parsedBudget, currency } } : {}),
        ...(market.trim() ? { market: market.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        model: selectedModel,
        reasoningEffort: selectedEffort,
      })
      setResult(research)
    } catch (searchError) {
      if (!cancelRequestedRef.current) setError(readableError(searchError))
    } finally {
      searchingRef.current = false
      setSearching(false)
      setCancelling(false)
    }
  }

  const cancel = () => {
    const productSearch = window.electronAPI.productSearch
    if (!productSearch) {
      setError(MISSING_PRODUCT_SEARCH_BRIDGE)
      return
    }
    cancelRequestedRef.current = true
    setCancelling(true)
    void productSearch.abort()
  }

  return (
    <div className="flex-1 overflow-y-auto bg-holmes-bg">
      <div className="mx-auto w-full max-w-6xl p-6 sm:p-8">
        <header className="mb-7 flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-holmes-primary/15 text-holmes-primary">
            <FontAwesomeIcon icon={faBagShopping} className="text-lg" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-medium text-white/85 font-serif-display">Product Search</h1>
              <span className="rounded-full border border-holmes-primary/25 bg-holmes-primary/10 px-2 py-0.5 text-[9px] font-semibold tracking-[0.13em] text-holmes-primary-light">
                LIVE WEB RESEARCH
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/40">
              Compare current products across retailers, manufacturer specifications, and independent reviews. {assistantName} ranks the evidence using your priorities.
            </p>
          </div>
        </header>

        <section className="overflow-hidden rounded-2xl border border-white/10 bg-holmes-surface">
          <div className="border-b border-white/[0.06] p-5">
            <label htmlFor="product-query" className="mb-2 block text-xs font-medium text-white/65">
              What are you looking for?
            </label>
            <div className="relative">
              <textarea
                id="product-query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void search()
                  }
                }}
                maxLength={500}
                rows={3}
                disabled={searching}
                placeholder="Example: A lightweight 14-inch laptop for travel, excellent battery life, under $1,500"
                className="w-full resize-none rounded-xl border border-white/10 bg-black/15 py-3 pl-11 pr-4 text-sm leading-relaxed text-white/85 outline-none placeholder:text-white/25 focus:border-holmes-primary/45 disabled:opacity-50"
              />
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-4 top-4 text-sm text-holmes-primary/70" />
            </div>
          </div>

          <div className="border-b border-white/[0.06] p-5">
            <div className="mb-3 flex items-center gap-2">
              <FontAwesomeIcon icon={faSliders} className="text-xs text-holmes-primary" />
              <h2 className="text-sm font-medium text-white/65 font-serif-display">Ranking priorities</h2>
              <span className="text-[10px] text-white/25">Toggle criteria and set their relative importance</span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {PRIORITY_OPTIONS.map((option) => {
                const weight = priorities[option.key]
                const enabled = weight > 0
                return (
                  <div
                    key={option.key}
                    className={`rounded-xl border p-3 transition-colors ${
                      enabled
                        ? 'border-holmes-primary/25 bg-holmes-primary/[0.07]'
                        : 'border-white/[0.07] bg-black/10'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => togglePriority(option.key, option.defaultWeight)}
                      disabled={searching}
                      className="flex w-full items-start gap-2.5 text-left disabled:cursor-not-allowed cursor-pointer"
                      aria-pressed={enabled}
                    >
                      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                        enabled ? 'bg-holmes-primary/15 text-holmes-primary-light' : 'bg-white/5 text-white/25'
                      }`}>
                        <FontAwesomeIcon icon={option.icon} className="text-xs" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block text-xs font-medium ${enabled ? 'text-white/75' : 'text-white/35'}`}>
                          {option.label}
                        </span>
                        <span className="mt-0.5 block text-[10px] leading-snug text-white/30">
                          {option.description}
                        </span>
                      </span>
                      <span className={`relative mt-1 h-4 w-7 shrink-0 rounded-full transition-colors ${
                        enabled ? 'bg-holmes-primary' : 'bg-white/10'
                      }`}>
                        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                          enabled ? 'translate-x-3.5' : 'translate-x-0.5'
                        }`} />
                      </span>
                    </button>
                    {enabled && (
                      <div className="mt-3 flex items-center gap-2">
                        <input
                          type="range"
                          min="1"
                          max="100"
                          value={weight}
                          disabled={searching}
                          onChange={(event) => setPriorities((current) => ({
                            ...current,
                            [option.key]: Number(event.target.value),
                          }))}
                          className="h-1 min-w-0 flex-1 accent-holmes-primary"
                          aria-label={`${option.label} priority weight`}
                        />
                        <span className="w-7 text-right text-[10px] tabular-nums text-holmes-primary-light/75">
                          {weight}
                        </span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="p-5">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <label className="block">
                <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-white/35">Maximum budget</span>
                <div className="flex overflow-hidden rounded-lg border border-white/10 bg-black/15 focus-within:border-holmes-primary/40">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={budget}
                    onChange={(event) => setBudget(event.target.value)}
                    disabled={searching}
                    placeholder="No limit"
                    className="min-w-0 flex-1 bg-transparent px-3 py-2 text-xs text-white/70 outline-none placeholder:text-white/20 disabled:opacity-50"
                  />
                  <select
                    value={currency}
                    onChange={(event) => setCurrency(event.target.value)}
                    disabled={searching}
                    className="border-l border-white/10 bg-holmes-surface px-2 text-[10px] text-white/50 outline-none disabled:opacity-50"
                  >
                    {['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'].map((code) => (
                      <option key={code} value={code}>{code}</option>
                    ))}
                  </select>
                </div>
              </label>
              <label className="block md:col-span-2">
                <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-white/35">Market or location</span>
                <input
                  value={market}
                  onChange={(event) => setMarket(event.target.value)}
                  maxLength={100}
                  disabled={searching}
                  placeholder="Example: United States, California"
                  className="w-full rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs text-white/70 outline-none placeholder:text-white/20 focus:border-holmes-primary/40 disabled:opacity-50"
                />
              </label>
            </div>
            <label className="mt-3 block">
              <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-white/35">Must-haves or exclusions</span>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                maxLength={2000}
                rows={2}
                disabled={searching}
                placeholder="Specific features, brands to avoid, preferred retailers, delivery deadline, refurbished policy..."
                className="w-full resize-none rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs leading-relaxed text-white/70 outline-none placeholder:text-white/20 focus:border-holmes-primary/40 disabled:opacity-50"
              />
            </label>

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4">
              <div className="min-w-52 flex-1">
                <ModelSelector
                  models={researchModels}
                  selectedModel={selectedModel}
                  onSelect={onModelChange}
                  disabled={searching}
                />
              </div>
              <select
                value={selectedEffort}
                onChange={(event) => onEffortChange(event.target.value as ReasoningEffort)}
                disabled={searching}
                className="rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs text-white/60 outline-none disabled:opacity-50"
              >
                <option value="low">Quick research</option>
                <option value="medium">Standard research</option>
                <option value="high">Deep research</option>
              </select>
              {searching ? (
                <button
                  onClick={cancel}
                  disabled={cancelling}
                  className="rounded-lg border border-red-300/20 bg-red-400/10 px-4 py-2 text-xs font-medium text-red-200/75 transition-colors hover:bg-red-400/15 disabled:opacity-50 cursor-pointer"
                >
                  {cancelling ? 'Cancelling...' : 'Cancel research'}
                </button>
              ) : (
                <button
                  onClick={() => void search()}
                  disabled={!query.trim() || !selectedModelCompatible || providerType !== 'openrouter'}
                  className="flex items-center gap-2 rounded-lg bg-holmes-primary px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-holmes-primary-light disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                >
                  <FontAwesomeIcon icon={faMagnifyingGlass} />
                  Research products
                </button>
              )}
            </div>

            {providerType !== 'openrouter' && (
              <p className="mt-3 rounded-lg border border-amber-300/15 bg-amber-300/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-100/65">
                Product Search requires OpenRouter because local and custom OpenAI-compatible providers do not expose a standard web-search and citation API.
              </p>
            )}
            {providerType === 'openrouter' && selectedModel && !selectedModelCompatible && (
              <p className="mt-3 rounded-lg border border-amber-300/15 bg-amber-300/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-100/65">
                The selected model does not advertise structured-output support. Choose a compatible model from the selector.
              </p>
            )}
            <p className="mt-3 text-[10px] leading-relaxed text-white/25">
              Live research can query multiple web sources and may incur OpenRouter search and model charges. Verify final price, condition, shipping, warranty, and availability with the seller before purchasing.
            </p>
          </div>
        </section>

        {error && (
          <div className="mt-5 flex items-start gap-3 rounded-xl border border-red-400/20 bg-red-400/[0.07] p-4 text-sm text-red-100/75">
            <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 shrink-0 text-red-300/70" />
            <span className="min-w-0 flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-xs text-red-100/40 hover:text-red-100 cursor-pointer">
              Dismiss
            </button>
          </div>
        )}

        {searching && (
          <section className="mt-6 overflow-hidden rounded-2xl border border-holmes-primary/20 bg-gradient-to-br from-holmes-primary/[0.08] to-transparent p-7 text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-holmes-primary/10 text-holmes-primary">
              <FontAwesomeIcon icon={faSpinner} spin className="text-xl" />
            </span>
            <h2 className="mt-4 text-sm font-medium text-white/75">Researching the live market</h2>
            <p className="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-white/35">
              {assistantName} is running targeted searches, checking current offers and specifications, comparing independent evidence, and ranking options against your priorities.
            </p>
          </section>
        )}

        {result && (
          <div className="mt-7 space-y-5">
            <section className="rounded-2xl border border-holmes-primary/20 bg-holmes-primary/[0.06] p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-3xl">
                  <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.13em] text-holmes-primary-light/75">
                    <FontAwesomeIcon icon={faGlobe} />
                    Research summary
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-white/65">{result.summary}</p>
                </div>
                <div className="shrink-0 text-right text-[10px] leading-relaxed text-white/25">
                  {result.webSearches !== undefined && <div>{result.webSearches} web searches</div>}
                  <div>{result.citations.length} verified sources</div>
                  <div>{new Date(result.researchedAt).toLocaleString()}</div>
                </div>
              </div>
            </section>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {result.recommendations.map((recommendation) => {
                const availability = AVAILABILITY[recommendation.availability]
                const recommendationSources = recommendation.sourceIds
                  .map((id) => result.citations.find((citation) => citation.id === id))
                  .filter((citation): citation is NonNullable<typeof citation> => Boolean(citation))
                return (
                  <article
                    key={`${recommendation.rank}-${recommendation.name}`}
                    className={`overflow-hidden rounded-2xl border bg-holmes-surface ${
                      recommendation.rank === 1 ? 'border-holmes-primary/35' : 'border-white/10'
                    }`}
                  >
                    <div className="border-b border-white/[0.06] p-5">
                      <div className="flex items-start gap-3">
                        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-semibold ${
                          recommendation.rank === 1
                            ? 'bg-holmes-primary text-white'
                            : 'bg-white/[0.06] text-white/45'
                        }`}>
                          {recommendation.rank}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[10px] uppercase tracking-wider text-white/30">{recommendation.brand}</div>
                          <h2 className="mt-0.5 text-base font-medium text-white/80 font-serif-display">{recommendation.name}</h2>
                          {recommendation.model && <div className="mt-0.5 text-[11px] text-white/35">{recommendation.model}</div>}
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-lg font-medium tabular-nums text-holmes-primary-light">
                            {Math.round(recommendation.overallScore)}
                          </div>
                          <div className="text-[9px] uppercase tracking-wider text-white/25">match</div>
                        </div>
                      </div>

                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-white/70">{recommendation.priceDisplay}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] ${availability.className}`}>
                          {availability.label}
                        </span>
                        {recommendation.rank === 1 && (
                          <span className="rounded-full border border-holmes-primary/25 bg-holmes-primary/10 px-2 py-0.5 text-[10px] text-holmes-primary-light/80">
                            Best overall match
                          </span>
                        )}
                      </div>
                      <p className="mt-3 text-[11px] text-white/35"><span className="text-white/50">Best for:</span> {recommendation.bestFor}</p>
                    </div>

                    <div className="p-5">
                      <p className="text-xs leading-relaxed text-white/55">{recommendation.rationale}</p>

                      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
                        {PRIORITY_OPTIONS.map((option) => (
                          <div key={option.key}>
                            <div className="mb-1 flex justify-between text-[9px] uppercase tracking-wider text-white/25">
                              <span>{option.label}</span>
                              <span>{Math.round(recommendation.scoreBreakdown[option.key])}</span>
                            </div>
                            <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
                              <div
                                className="h-full rounded-full bg-holmes-primary/70"
                                style={{ width: `${recommendation.scoreBreakdown[option.key]}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                          <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-emerald-200/55">
                            <FontAwesomeIcon icon={faCircleCheck} /> Highlights
                          </h3>
                          <ul className="space-y-1.5">
                            {recommendation.highlights.map((highlight) => (
                              <li key={highlight} className="text-[11px] leading-relaxed text-white/40">{highlight}</li>
                            ))}
                          </ul>
                        </div>
                        <div>
                          <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-amber-100/50">
                            <FontAwesomeIcon icon={faTriangleExclamation} /> Tradeoffs
                          </h3>
                          {recommendation.tradeoffs.length > 0 ? (
                            <ul className="space-y-1.5">
                              {recommendation.tradeoffs.map((tradeoff) => (
                                <li key={tradeoff} className="text-[11px] leading-relaxed text-white/40">{tradeoff}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-[11px] text-white/25">No material tradeoffs found in the available evidence.</p>
                          )}
                        </div>
                      </div>

                      {recommendationSources.length > 0 && (
                        <div className="mt-5 flex flex-wrap gap-1.5 border-t border-white/[0.06] pt-4">
                          {recommendationSources.map((source) => (
                            <button
                              key={source.id}
                              onClick={() => void onOpenExternal(source.url)}
                              title={source.title}
                              className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] text-white/35 transition-colors hover:border-holmes-primary/30 hover:text-holmes-primary-light cursor-pointer"
                            >
                              {source.domain}
                              <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="text-[8px]" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
              <section className="rounded-2xl border border-white/10 bg-holmes-surface p-5 lg:col-span-3">
                <h2 className="text-sm font-medium text-white/65 font-serif-display">Before you buy</h2>
                <ul className="mt-3 space-y-2">
                  {result.buyingAdvice.map((advice) => (
                    <li key={advice} className="flex gap-2 text-xs leading-relaxed text-white/40">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-holmes-primary/70" />
                      {advice}
                    </li>
                  ))}
                </ul>
                <p className="mt-4 border-t border-white/[0.06] pt-4 text-[10px] leading-relaxed text-white/25">
                  {result.methodology}
                </p>
              </section>

              <section className="rounded-2xl border border-white/10 bg-holmes-surface p-5 lg:col-span-2">
                <h2 className="flex items-center gap-2 text-sm font-medium text-white/65 font-serif-display">
                  <FontAwesomeIcon icon={faGlobe} className="text-holmes-primary" />
                  Verified web sources
                </h2>
                <div className="mt-3 space-y-1.5">
                  {result.citations.map((source) => (
                    <button
                      key={source.id}
                      onClick={() => void onOpenExternal(source.url)}
                      className="flex w-full items-center gap-2 rounded-lg border border-white/[0.06] bg-black/10 px-3 py-2 text-left transition-colors hover:border-holmes-primary/25 hover:bg-holmes-primary/[0.04] cursor-pointer"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] text-white/50">{source.title}</span>
                        <span className="mt-0.5 block truncate text-[9px] text-white/25">{source.domain}</span>
                      </span>
                      <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="shrink-0 text-[9px] text-white/25" />
                    </button>
                  ))}
                </div>
                <p className="mt-3 truncate text-[9px] text-white/20" title={result.model}>Model: {result.model}</p>
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
