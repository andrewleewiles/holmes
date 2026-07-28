import { type FC } from 'react'
import type { FinancesSummary } from '@shared/types'

interface FinancesWidgetProps {
  summary: FinancesSummary | null
}

const ACCENT = '#059669'
const ACCENT_TRACK = 'rgba(5, 150, 105, 0.15)'

function formatMoney(cents: number): string {
  const dollars = cents / 100
  return dollars.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

function monthlyCentsOf(sub: FinancesSummary['activeSubscriptions'][number]): number | null {
  const cadence = sub.cadence.toLowerCase()
  if (cadence.startsWith('month') || cadence === 'mo') return sub.amountCents
  if (cadence.startsWith('year') || cadence.startsWith('annual') || cadence === 'yr') return sub.amountCents / 12
  if (cadence.startsWith('week') || cadence === 'wk') return (sub.amountCents * 52) / 12
  if (cadence.startsWith('quarter')) return sub.amountCents / 3
  return null
}

export const FinancesWidget: FC<FinancesWidgetProps> = ({ summary }) => {
  if (!summary) {
    return (
      <p className="text-xs text-white/30">
        No finances summary yet.
      </p>
    )
  }

  const monthlyAmounts = summary.activeSubscriptions.map(monthlyCentsOf)
  const comparable = monthlyAmounts.every((amount) => amount !== null)
  const maxMonthly = comparable ? Math.max(...monthlyAmounts.map((amount) => amount ?? 0), 0) : 0

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">Recurring spend</div>
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-semibold text-white/90">{formatMoney(summary.totalMonthlyCents)}</span>
          <span className="text-xs text-white/40">/mo</span>
        </div>
      </div>

      {summary.activeSubscriptions.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider mb-1.5">Active subscriptions</h3>
          <ul className="space-y-2">
            {summary.activeSubscriptions.map((sub, idx) => {
              const monthly = monthlyAmounts[idx]
              return (
                <li key={idx}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="truncate text-[11px] text-white/65">
                      {sub.provider}
                      {sub.planName ? <span className="text-white/35"> · {sub.planName}</span> : null}
                    </span>
                    <span className="shrink-0 text-[11px] text-white/40 tabular-nums">
                      {formatMoney(sub.amountCents)}/{sub.cadence}
                    </span>
                  </div>
                  {comparable && (
                    <div className="h-1 rounded-full overflow-hidden" style={{ backgroundColor: ACCENT_TRACK }}>
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${maxMonthly > 0 ? Math.max(3, ((monthly ?? 0) / maxMonthly) * 100) : 3}%`,
                          backgroundColor: ACCENT,
                        }}
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {summary.recentChanges.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider mb-1.5">Recent changes</h3>
          <ul className="space-y-1">
            {summary.recentChanges.map((change, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full" style={{ backgroundColor: ACCENT }} />
                <span className="text-[11px] leading-relaxed text-white/55">{change}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-white/50 leading-relaxed">{summary.summary}</p>
    </div>
  )
}
