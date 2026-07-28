import { type FC } from 'react'
import type { HealthAnalysis, HealthDomainScore, HealthThread, HealthInteraction, HealthRegimenEntry } from '@shared/types'

interface HealthWidgetProps {
  analysis: HealthAnalysis
  compact?: boolean
}

const STATUS_GOOD = '#059669'
const STATUS_WARN = '#d97706'
const STATUS_BAD = '#ef4444'
const NEUTRAL = '#6b7280'

const TREND_ARROW: Record<string, string> = {
  up: '↑',
  down: '↓',
  stable: '→',
  unknown: '–',
}

const SEVERITY_COLOR: Record<string, string> = {
  low: STATUS_GOOD,
  medium: STATUS_WARN,
  high: STATUS_BAD,
}

const PRIORITY_COLOR: Record<string, string> = {
  low: NEUTRAL,
  medium: STATUS_WARN,
  high: STATUS_BAD,
}

function scoreColor(score: number): string {
  return score >= 70 ? STATUS_GOOD : score >= 40 ? STATUS_WARN : STATUS_BAD
}

function DomainBar({ score, compact = false }: { score: HealthDomainScore; compact?: boolean }) {
  const color = scoreColor(score.score)
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-white/60 truncate">{score.label}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          {score.trend && (
            <span className="text-[10px] text-white/35" title={`Trend: ${score.trend}`}>
              {TREND_ARROW[score.trend] ?? '–'}
            </span>
          )}
          <span className="text-[11px] text-white/40 tabular-nums">{score.score}</span>
        </div>
      </div>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.max(2, Math.min(100, score.score))}%`, backgroundColor: color }}
        />
      </div>
      {!compact && score.notes && (
        <p className="text-[10px] leading-relaxed text-white/35">{score.notes}</p>
      )}
    </div>
  )
}

function StatusStrip({ domains }: { domains: HealthDomainScore[] }) {
  const bands = [
    { label: 'strong', color: STATUS_GOOD, count: domains.filter((d) => d.score >= 70).length },
    { label: 'moderate', color: STATUS_WARN, count: domains.filter((d) => d.score >= 40 && d.score < 70).length },
    { label: 'attention', color: STATUS_BAD, count: domains.filter((d) => d.score < 40).length },
  ].filter((band) => band.count > 0)
  if (bands.length === 0) return null
  return (
    <div className="flex items-center gap-4">
      {bands.map((band) => (
        <div key={band.label} className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: band.color }} />
          <span className="text-[11px] text-white/55">
            <span className="text-white/80 font-medium tabular-nums">{band.count}</span> {band.label}
          </span>
        </div>
      ))}
    </div>
  )
}

function FlagPill({ flag }: { flag: NonNullable<HealthAnalysis['recentObservations'][number]['flag']> }) {
  const styles =
    flag === 'high' || flag === 'abnormal'
      ? 'bg-red-400/10 text-red-300/90'
      : flag === 'low'
        ? 'bg-amber-400/10 text-amber-300/90'
        : 'bg-white/5 text-white/40'
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-px text-[9px] uppercase tracking-wider ${styles}`}>
      {flag}
    </span>
  )
}

function RegimenChip({ entry, accent }: { entry: HealthRegimenEntry; accent?: boolean }) {
  const styles = accent
    ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100/80'
    : 'border-white/10 bg-white/5 text-white/60'
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] ${styles}`}
      title={[entry.dose, entry.schedule, entry.notes].filter(Boolean).join(' · ') || undefined}
    >
      {entry.name}
      {entry.dose ? <span className="text-white/35"> {entry.dose}</span> : null}
    </span>
  )
}

function ThreadRow({ thread, compact = false }: { thread: HealthThread; compact?: boolean }) {
  const dotColor = PRIORITY_COLOR[thread.priority] ?? NEUTRAL
  return (
    <div className="flex items-start gap-2">
      <span
        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: dotColor }}
        title={`Priority: ${thread.priority}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[11px] text-white/70">{thread.title}</span>
          <span className="shrink-0 rounded-full bg-white/5 px-1.5 py-px text-[9px] uppercase tracking-wider text-white/40">
            {thread.status}
          </span>
        </div>
        {!compact && thread.detail && (
          <p className="mt-0.5 text-[10px] leading-relaxed text-white/35 line-clamp-2">{thread.detail}</p>
        )}
      </div>
    </div>
  )
}

function InteractionRow({ interaction }: { interaction: HealthInteraction }) {
  const color = SEVERITY_COLOR[interaction.severity] ?? NEUTRAL
  return (
    <div className="flex items-start gap-2">
      <span
        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        title={`Severity: ${interaction.severity}`}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] leading-relaxed text-white/60">{interaction.description}</p>
        <p className="mt-0.5 text-[9px] text-white/30">{interaction.agents.join(' · ')}</p>
      </div>
    </div>
  )
}

export const HealthWidget: FC<HealthWidgetProps> = ({ analysis, compact = false }) => {
  const topThreads = compact ? analysis.openThreads.slice(0, 3) : analysis.openThreads
  const visibleDomains = compact ? analysis.domainScores.slice(0, 6) : analysis.domainScores
  const recentObservations = analysis.recentObservations.slice(0, compact ? 5 : undefined)
  const medications = analysis.regimen?.medications ?? []
  const supplements = analysis.regimen?.supplements ?? []

  return (
    <div className="space-y-5">
      {visibleDomains.length > 0 && (
        <div>
          <div className="flex items-center justify-between gap-2 mb-2">
            <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider">Domains</h3>
            <StatusStrip domains={analysis.domainScores} />
          </div>
          <div className={compact ? 'grid grid-cols-2 gap-x-5 gap-y-2' : 'space-y-2.5'}>
            {visibleDomains.map((score) => (
              <DomainBar key={`${score.domain}-${score.label}`} score={score} compact={compact} />
            ))}
          </div>
        </div>
      )}

      {recentObservations.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2">Recent observations</h3>
          <ul className="space-y-1.5">
            {recentObservations.map((obs, idx) => (
              <li key={idx} className="flex items-center gap-2">
                <span className="truncate text-[11px] text-white/65 flex-1 min-w-0">{obs.name}</span>
                {obs.flag && <FlagPill flag={obs.flag} />}
                <span className="shrink-0 text-[11px] text-white/60 tabular-nums">{obs.value}</span>
                <span className="shrink-0 text-[10px] text-white/30 tabular-nums">{obs.date}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!compact && (medications.length > 0 || supplements.length > 0) && (
        <div>
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2">Regimen</h3>
          <div className="flex flex-wrap gap-1.5">
            {medications.map((entry, idx) => (
              <RegimenChip key={`med-${idx}`} entry={entry} accent />
            ))}
            {supplements.map((entry, idx) => (
              <RegimenChip key={`sup-${idx}`} entry={entry} />
            ))}
          </div>
          {analysis.regimen?.notes && (
            <p className="mt-1.5 text-[10px] leading-relaxed text-white/35">{analysis.regimen.notes}</p>
          )}
        </div>
      )}

      {analysis.interactions.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2">Interactions</h3>
          <div className="space-y-2">
            {analysis.interactions.slice(0, compact ? 2 : undefined).map((interaction, idx) => (
              <InteractionRow key={idx} interaction={interaction} />
            ))}
          </div>
        </div>
      )}

      {topThreads.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2">Open threads</h3>
          <div className="space-y-2">
            {topThreads.map((thread, idx) => (
              <ThreadRow key={idx} thread={thread} compact={compact} />
            ))}
          </div>
        </div>
      )}

      {analysis.recommendedLabs.length > 0 && !compact && (
        <div>
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2">Recommended labs</h3>
          <ul className="space-y-1">
            {analysis.recommendedLabs.map((lab, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-white/30" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-white/65">{lab.name}</span>
                    <span className="shrink-0 rounded-full bg-white/5 px-1.5 py-px text-[9px] uppercase tracking-wider text-white/40">
                      {lab.status}
                    </span>
                  </div>
                  {lab.rationale && (
                    <p className="mt-0.5 text-[10px] leading-relaxed text-white/35">{lab.rationale}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-white/50 leading-relaxed">{analysis.summary}</p>

      <p className="text-[10px] leading-relaxed text-white/25">
        Synthesized from your health documents. Not a diagnosis or medical advice — bring to a clinician for interpretation.
      </p>
    </div>
  )
}
