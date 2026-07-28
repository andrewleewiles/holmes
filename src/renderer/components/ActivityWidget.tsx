import { type FC } from 'react'
import type { ActivityAnalysis } from '@shared/types'

interface ActivityWidgetProps {
  analysis: ActivityAnalysis | null
  compact?: boolean
}

const ACCENT = '#d97706'
const ACCENT_TRACK = 'rgba(217, 119, 6, 0.15)'

function formatMoney(cents: number): string {
  const dollars = cents / 100
  return dollars.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

interface BarItem {
  label: string
  value: string
  amount: number
}

function BarList({ items }: { items: BarItem[] }) {
  const max = Math.max(...items.map((item) => item.amount), 0)
  return (
    <ul className="space-y-2">
      {items.map((item, idx) => (
        <li key={idx}>
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="truncate text-[11px] text-white/65">{item.label}</span>
            <span className="shrink-0 text-[11px] text-white/40 tabular-nums">{item.value}</span>
          </div>
          <div className="h-1 rounded-full overflow-hidden" style={{ backgroundColor: ACCENT_TRACK }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${max > 0 ? Math.max(3, (item.amount / max) * 100) : 3}%`,
                backgroundColor: ACCENT,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

export const ActivityWidget: FC<ActivityWidgetProps> = ({ analysis, compact = false }) => {
  if (!analysis) {
    return (
      <p className="text-xs text-white/30">
        No activity analysis yet.
      </p>
    )
  }

  const media = analysis.mediaConsumption
  const spending = analysis.spendingPatterns
  const digital = analysis.digitalBehavior
  const location = analysis.locationPatterns
  const comm = analysis.communicationPatterns

  const topInterests = compact ? analysis.topInterests.slice(0, 6) : analysis.topInterests
  const visibleMedia = compact ? media.slice(0, 4) : media
  const visibleSpending = compact ? spending.slice(0, 4) : spending
  const visibleDigital = compact ? digital.slice(0, 4) : digital
  const visibleLocation = compact ? location.slice(0, 4) : location
  const visibleComm = compact ? comm.slice(0, 4) : comm
  const visibleThreads = compact ? analysis.openThreads.slice(0, 3) : analysis.openThreads

  return (
    <div className="space-y-5">
      {topInterests.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2">Top interests</h3>
          <div className="flex flex-wrap gap-1.5">
            {topInterests.map((interest, idx) => (
              <span
                key={idx}
                className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-100/80"
              >
                {interest}
              </span>
            ))}
          </div>
        </div>
      )}

      {visibleMedia.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2">Media consumption</h3>
          <BarList
            items={visibleMedia.map((item) => ({
              label: item.topic,
              value: `${item.hoursWeekly.toFixed(1)}h/wk`,
              amount: item.hoursWeekly,
            }))}
          />
        </div>
      )}

      {visibleSpending.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2">Spending patterns</h3>
          <BarList
            items={visibleSpending.map((item) => ({
              label: item.category,
              value: `${formatMoney(item.monthlyCents)}/mo`,
              amount: item.monthlyCents,
            }))}
          />
        </div>
      )}

      {visibleDigital.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2">Digital behavior</h3>
          <BarList
            items={visibleDigital.map((item) => ({
              label: item.app,
              value: `${item.hoursWeekly.toFixed(1)}h/wk${item.mood ? ` · ${item.mood}` : ''}`,
              amount: item.hoursWeekly,
            }))}
          />
        </div>
      )}

      {!compact && visibleLocation.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2">Location patterns</h3>
          <BarList
            items={visibleLocation.map((item) => ({
              label: item.place,
              value: `${item.visitsMonthly}/mo`,
              amount: item.visitsMonthly,
            }))}
          />
        </div>
      )}

      {!compact && visibleComm.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2">Communication patterns</h3>
          <ul className="space-y-1">
            {visibleComm.map((item, idx) => (
              <li key={idx} className="flex items-center justify-between gap-2">
                <span className="truncate text-[11px] text-white/65">{item.contact}</span>
                <span className="shrink-0 text-[11px] text-white/40">{item.frequency}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!compact && analysis.weatherMoodCorrelations.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2">Weather/mood correlations</h3>
          <ul className="space-y-1">
            {analysis.weatherMoodCorrelations.map((line, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-white/30" />
                <span className="text-[11px] leading-relaxed text-white/55">{line}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {visibleThreads.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2">Open threads</h3>
          <ul className="space-y-1">
            {visibleThreads.map((thread, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: ACCENT }} />
                <span className="text-[11px] leading-relaxed text-white/60">{thread}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-white/50 leading-relaxed">{analysis.summary}</p>

      <p className="text-[10px] leading-relaxed text-white/25">
        Synthesized from your activity sources. Patterns are descriptive observations, not judgments or recommendations.
      </p>

      <p className="text-[10px] text-white/30">
        {media.length} media topics · {spending.length} spending categories · {digital.length} apps
      </p>
    </div>
  )
}
