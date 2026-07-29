import { type FC } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCoins, faTriangleExclamation, faCalculator, faSpinner } from '@fortawesome/free-solid-svg-icons'
import type { IndexEstimate, IndexGranularity, ModelTier } from '@shared/types'
import { INDEX_GRANULARITIES, MODEL_TIERS } from '@shared/types'

interface IndexEstimateBarProps {
  estimate: IndexEstimate | null
  loading: boolean
  tier: ModelTier
  onTierChange: (tier: ModelTier) => void
  granularity: IndexGranularity
  onGranularityChange: (granularity: IndexGranularity) => void
  onEstimate: () => void
  disabled?: boolean
  error?: string | null
}

const TIER_LABELS: Record<ModelTier, string> = {
  budget: 'Budget',
  mid: 'Mid',
  frontier: 'Frontier',
}

const GRANULARITY_LABELS: Record<IndexGranularity, string> = {
  low: 'Low',
  medium: 'Medium',
  full: 'Full',
}

// Mirrors GRANULARITY_PHOTO_RATE in the main process — a UI hint, not the
// authority; the estimate's sampledOutFiles carries the real number.
const GRANULARITY_HINTS: Record<IndexGranularity, string> = {
  low: 'Sample roughly 1 in 16 photos per folder. Documents are always indexed in full.',
  medium: 'Sample roughly 1 in 4 photos per folder. Documents are always indexed in full.',
  full: 'Index every photo individually.',
}

export function formatEstimateCost(value: number | null): string {
  if (value === null) return 'cost unknown'
  if (value === 0) return 'free'
  if (value < 0.01) return 'under $0.01'
  if (value < 1000) return `$${value.toFixed(2)}`
  return `$${Math.round(value).toLocaleString()}`
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = seconds / 3600
  return hours < 10 ? `${hours.toFixed(1)} hrs` : `${Math.round(hours)} hrs`
}

function formatCount(value: number): string {
  return value.toLocaleString()
}

export const IndexEstimateBar: FC<IndexEstimateBarProps> = ({ estimate, loading, tier, onTierChange, granularity, onGranularityChange, onEstimate, disabled, error }) => {
  const nothingToDo = estimate !== null && estimate.textFiles === 0 && estimate.imageFiles === 0

  return (
    <div className="rounded-lg border border-white/[0.07] bg-black/15 px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-white/35 shrink-0">Tier</span>
        <div className="flex gap-1">
          {MODEL_TIERS.map((option) => (
            <button
              key={option}
              onClick={() => onTierChange(option)}
              disabled={disabled}
              className={`px-2 py-0.5 rounded text-[10px] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default ${
                tier === option
                  ? 'bg-cyan-400/20 text-cyan-100 border border-cyan-400/30'
                  : 'bg-white/[0.04] text-white/50 border border-transparent hover:text-white/75'
              }`}
            >
              {TIER_LABELS[option]}
            </button>
          ))}
        </div>

        <span className="text-[10px] uppercase tracking-wider text-white/35 shrink-0 ml-2" title="How many photos the run reads. Tier picks which model looks; granularity picks how much it looks at.">Granularity</span>
        <div className="flex gap-1">
          {INDEX_GRANULARITIES.map((option) => (
            <button
              key={option}
              onClick={() => onGranularityChange(option)}
              disabled={disabled}
              title={GRANULARITY_HINTS[option]}
              className={`px-2 py-0.5 rounded text-[10px] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default ${
                granularity === option
                  ? 'bg-cyan-400/20 text-cyan-100 border border-cyan-400/30'
                  : 'bg-white/[0.04] text-white/50 border border-transparent hover:text-white/75'
              }`}
            >
              {GRANULARITY_LABELS[option]}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 ml-auto text-[11px] text-white/55">
          {/* Scanning a photo tree walks tens of thousands of directory entries,
              so it only ever runs when the user asks for it. */}
          <button
            onClick={onEstimate}
            disabled={disabled || loading}
            title="Scan this directory and price the run at the selected tier"
            className="flex items-center gap-1.5 rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-white/55 hover:border-cyan-400/30 hover:text-cyan-200/80 disabled:opacity-40 disabled:hover:border-white/10 disabled:hover:text-white/55 cursor-pointer transition-colors"
          >
            <FontAwesomeIcon icon={loading ? faSpinner : faCalculator} className={`text-[9px] ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Scanning…' : estimate ? 'Re-estimate' : 'Estimate cost'}
          </button>
          <FontAwesomeIcon icon={faCoins} className="text-[10px] text-white/30" />
          {loading ? (
            <span className="text-white/35">…</span>
          ) : error ? (
            <span className="text-red-300/70">{error}</span>
          ) : estimate ? (
            <span>
              <span className={estimate.costUsd === null ? 'text-amber-200/70' : 'text-cyan-200/80'}>
                {formatEstimateCost(estimate.costUsd)}
              </span>
              {!nothingToDo && <span className="text-white/30"> · ~{formatDuration(estimate.estimatedSeconds)}</span>}
            </span>
          ) : (
            <span className="text-white/30">not estimated</span>
          )}
        </div>
      </div>

      {estimate && !loading && (
        <div className="text-[10px] leading-relaxed text-white/35">
          {nothingToDo ? (
            <span>
              Nothing to index — {estimate.cachedFiles > 0
                ? `all ${formatCount(estimate.cachedFiles)} item${estimate.cachedFiles === 1 ? '' : 's'} are already summarized and unchanged`
                : 'no items to summarize'}
              {estimate.sampledOutFiles > 0 && <>; {formatCount(estimate.sampledOutFiles)} photo{estimate.sampledOutFiles === 1 ? '' : 's'} sampled out at {GRANULARITY_LABELS[estimate.granularity].toLowerCase()} granularity</>}.
            </span>
          ) : (
            <span>
              {estimate.imageFiles > 0 && (
                <>{formatCount(estimate.imageFiles)} photo{estimate.imageFiles === 1 ? '' : 's'} via {estimate.visionModel || 'no vision model'}</>
              )}
              {estimate.imageFiles > 0 && estimate.textFiles > 0 && ' · '}
              {estimate.textFiles > 0 && (
                <>{formatCount(estimate.textFiles)} document{estimate.textFiles === 1 ? '' : 's'} via {estimate.textModel}</>
              )}
              {estimate.folders > 0 && <> · {formatCount(estimate.folders)} folder synthes{estimate.folders === 1 ? 'is' : 'es'}</>}
              {estimate.cachedFiles > 0 && <> · {formatCount(estimate.cachedFiles)} cached, skipped</>}
              {estimate.sampledOutFiles > 0 && <> · {formatCount(estimate.sampledOutFiles)} photo{estimate.sampledOutFiles === 1 ? '' : 's'} sampled out, not billed</>}
            </span>
          )}
        </div>
      )}

      {estimate?.visionModelMissing && (
        <p className="flex items-start gap-1.5 text-[10px] text-amber-200/70">
          <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 text-[9px]" />
          No vision model set for the {TIER_LABELS[tier]} tier — those {formatCount(estimate.imageFiles)} photos would be recorded as failures. Set one in Settings.
        </p>
      )}

      {estimate?.visionModelUnsupported && (
        <p className="flex items-start gap-1.5 text-[10px] text-amber-200/70">
          <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 text-[9px]" />
          {estimate.visionModel} does not accept image input. Pick an image-capable model for this tier.
        </p>
      )}

      {estimate?.pricingUnavailable && !estimate.visionModelMissing && (
        <p className="text-[10px] text-amber-200/60">
          Your provider reports no pricing for at least one of these models, so the total cannot be quoted.
        </p>
      )}

      {estimate?.truncatedAtCap && (
        <p className="flex items-start gap-1.5 text-[10px] text-amber-200/70">
          <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 text-[9px]" />
          Scan hit the {formatCount(estimate.scannedFiles)} file ceiling — this directory holds more than one run can cover.
        </p>
      )}
    </div>
  )
}
