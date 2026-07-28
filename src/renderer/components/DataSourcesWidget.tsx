import { type FC } from 'react'

export interface DataSourcesSummary {
  activityRecords: number
  activityNeedsAttention: number
  activitySourcesAnalyzed: number
  activitySuperContext: boolean
  healthRecords: number
  filesCount: number
  psychologyAnalyzed: boolean
  financesAnalyzed: boolean
}

interface DataSourcesWidgetProps {
  summary: DataSourcesSummary
  compact?: boolean
}

type SourceState = 'ok' | 'warn' | 'empty'

const STATE_COLOR: Record<SourceState, string> = {
  ok: '#0891b2',
  warn: '#d97706',
  empty: 'rgba(255, 255, 255, 0.2)',
}

export const DataSourcesWidget: FC<DataSourcesWidgetProps> = ({ summary, compact }) => {
  const rows: Array<{ label: string; value: string; state: SourceState }> = [
    {
      label: 'Activity sources',
      value: `${summary.activitySourcesAnalyzed} analyzed${summary.activityRecords > 0 ? ` · ${summary.activityRecords} record${summary.activityRecords === 1 ? '' : 's'}` : ''}`,
      state:
        summary.activityNeedsAttention > 0
          ? 'warn'
          : summary.activitySourcesAnalyzed > 0 || summary.activityRecords > 0
            ? 'ok'
            : 'empty',
    },
    {
      label: 'Super-context',
      value: summary.activitySuperContext ? 'Synthesized' : 'Not synthesized',
      state: summary.activitySuperContext ? 'ok' : 'empty',
    },
    {
      label: 'Health sources',
      value: `${summary.healthRecords} record${summary.healthRecords === 1 ? '' : 's'}`,
      state: summary.healthRecords > 0 ? 'ok' : 'empty',
    },
    {
      label: 'Files in scope',
      value: `${summary.filesCount} file${summary.filesCount === 1 ? '' : 's'}`,
      state: summary.filesCount > 0 ? 'ok' : 'empty',
    },
    {
      label: 'Psychology',
      value: summary.psychologyAnalyzed ? 'Analyzed' : 'Not analyzed',
      state: summary.psychologyAnalyzed ? 'ok' : 'empty',
    },
    {
      label: 'Finances',
      value: summary.financesAnalyzed ? 'Analyzed' : 'Not analyzed',
      state: summary.financesAnalyzed ? 'ok' : 'empty',
    },
  ]

  const connected = rows.filter((row) => row.state === 'ok').length

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-white/45">
          <span className="text-white/80 font-medium tabular-nums">{connected}</span> of{' '}
          <span className="tabular-nums">{rows.length}</span> sources feeding context
        </span>
      </div>

      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label} className="bg-white/5 rounded-lg p-2.5 min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: STATE_COLOR[row.state] }}
              />
              <span className="truncate text-[10px] text-white/40 uppercase tracking-wider">{row.label}</span>
            </div>
            <div className={`truncate ${compact ? 'text-xs' : 'text-sm'} ${row.state === 'warn' ? 'text-amber-300/90' : row.state === 'empty' ? 'text-white/40' : 'text-white/75'}`} title={row.value}>
              {row.value}
            </div>
          </div>
        ))}
      </div>

      {summary.activityNeedsAttention > 0 && (
        <div className={`${compact ? 'text-[10px]' : 'text-xs'} text-amber-300/80 pt-1 border-t border-white/5`}>
          {summary.activityNeedsAttention} source{summary.activityNeedsAttention === 1 ? '' : 's'} need attention{compact ? '' : ' — open Data to resolve'}
        </div>
      )}
    </div>
  )
}
