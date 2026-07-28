import { type FC } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCalculator, faCoins, faSpinner, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import type { ActivityAnalysisEstimate, ModelTier } from '@shared/types'
import { MODEL_TIERS } from '@shared/types'
import { formatDuration, formatEstimateCost } from './IndexEstimateBar'

/**
 * Cost projection and tier picker for the Activity analysis, mirroring
 * `IndexEstimateBar`. The two runs are different shapes — one is per file, this
 * one is per source — but the decision the user is making is the same, so the
 * controls and the cost formatting are shared rather than reinvented.
 */
interface AnalysisEstimateBarProps {
  estimate: ActivityAnalysisEstimate | null
  loading: boolean
  tier: ModelTier
  onTierChange: (tier: ModelTier) => void
  onEstimate: () => void
  disabled?: boolean
  error?: string | null
}

const TIER_LABELS: Record<ModelTier, string> = {
  budget: 'Budget',
  mid: 'Mid',
  frontier: 'Frontier',
}

function formatCount(value: number): string {
  return value.toLocaleString()
}

export const AnalysisEstimateBar: FC<AnalysisEstimateBarProps> = ({
  estimate,
  loading,
  tier,
  onTierChange,
  onEstimate,
  disabled,
  error,
}) => {
  const nothingToDo = estimate !== null && estimate.callCount === 0

  return (
    <div className="space-y-2 rounded-lg border border-white/[0.07] bg-black/15 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-white/35">Tier</span>
        <div className="flex gap-1">
          {MODEL_TIERS.map((option) => (
            <button
              key={option}
              onClick={() => onTierChange(option)}
              disabled={disabled}
              className={`cursor-pointer rounded px-2 py-0.5 text-[10px] transition-colors disabled:cursor-default disabled:opacity-40 ${
                tier === option
                  ? 'border border-amber-400/30 bg-amber-400/20 text-amber-100'
                  : 'border border-transparent bg-white/[0.04] text-white/50 hover:text-white/75'
              }`}
            >
              {TIER_LABELS[option]}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2 text-[11px] text-white/55">
          <button
            onClick={onEstimate}
            disabled={disabled || loading}
            title="Price this analysis at the selected tier"
            className="flex cursor-pointer items-center gap-1.5 rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-white/55 transition-colors hover:border-amber-400/30 hover:text-amber-200/80 disabled:opacity-40 disabled:hover:border-white/10 disabled:hover:text-white/55"
          >
            <FontAwesomeIcon
              icon={loading ? faSpinner : faCalculator}
              className={`text-[9px] ${loading ? 'animate-spin' : ''}`}
            />
            {loading ? 'Estimating…' : estimate ? 'Re-estimate' : 'Estimate cost'}
          </button>
          <FontAwesomeIcon icon={faCoins} className="text-[10px] text-white/30" />
          {loading ? (
            <span className="text-white/35">…</span>
          ) : error ? (
            <span className="text-red-300/70">{error}</span>
          ) : estimate ? (
            <span>
              <span className={estimate.costUsd === null ? 'text-amber-200/70' : 'text-amber-200/80'}>
                {formatEstimateCost(estimate.costUsd)}
              </span>
              {!nothingToDo && (
                <span className="text-white/30"> · ~{formatDuration(estimate.estimatedSeconds)}</span>
              )}
            </span>
          ) : (
            <span className="text-white/30">not estimated</span>
          )}
        </div>
      </div>

      {estimate && !loading && (
        <div className="text-[10px] leading-relaxed text-white/35">
          {nothingToDo ? (
            <span>No activity events to analyze yet — import or sync a source first.</span>
          ) : (
            <span>
              {formatCount(estimate.callCount)} call{estimate.callCount === 1 ? '' : 's'} via {estimate.textModel}
              {' · '}
              {formatCount(estimate.totalEvents)} event{estimate.totalEvents === 1 ? '' : 's'}
              {' · '}
              {formatCount(estimate.inputTokens)} in / {formatCount(estimate.outputTokens)} out
            </span>
          )}
        </div>
      )}

      {/* Per-source breakdown: which sources this run covers, and how much of
          the bill each accounts for. */}
      {estimate && !loading && estimate.lines.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-[10px] text-white/30 transition-colors hover:text-white/55">
            Breakdown by source
          </summary>
          <ul className="mt-1.5 space-y-0.5">
            {estimate.lines.map((line) => (
              <li key={line.label} className="flex items-center gap-2 text-[10px]">
                <span className="min-w-0 flex-1 truncate capitalize text-white/45">{line.label}</span>
                {line.eventCount > 0 && (
                  <span className="shrink-0 text-white/25">{formatCount(line.eventCount)} events</span>
                )}
                <span className="shrink-0 tabular-nums text-white/35">
                  {formatEstimateCost(line.costUsd)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {estimate?.upToDate && !loading && !nothingToDo && (
        <p className="flex items-start gap-1.5 text-[10px] text-white/40">
          <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 text-[9px]" />
          The stored analysis is already current for this data — running again would spend this to reproduce it.
        </p>
      )}

      {estimate && estimate.skippedAccounts.length > 0 && !loading && (
        <p className="flex items-start gap-1.5 text-[10px] text-amber-200/60">
          <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 text-[9px]" />
          Not included in this run: {estimate.skippedAccounts.join(', ')}. Only the busiest accounts are analyzed
          each time.
        </p>
      )}

      {estimate?.pricingUnavailable && !loading && (
        <p className="text-[10px] text-amber-200/60">
          This provider reports no pricing, so the cost is unknown rather than free.
        </p>
      )}
    </div>
  )
}
