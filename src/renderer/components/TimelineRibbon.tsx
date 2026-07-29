import { type FC, useMemo, useState } from 'react'
import type { TimelineCategory, TimelineEra, TimelineEvent } from '@shared/types'
import { TIMELINE_CATEGORIES } from '@shared/timeline'

export const CATEGORY_STYLE: Record<TimelineCategory, { dot: string; chip: string; text: string }> = {
  milestone: { dot: 'bg-amber-300', chip: 'border-amber-400/40 bg-amber-400/10', text: 'text-amber-200/90' },
  health: { dot: 'bg-emerald-400', chip: 'border-emerald-400/40 bg-emerald-400/10', text: 'text-emerald-200/90' },
  training: { dot: 'bg-lime-400', chip: 'border-lime-400/40 bg-lime-400/10', text: 'text-lime-200/90' },
  work: { dot: 'bg-sky-400', chip: 'border-sky-400/40 bg-sky-400/10', text: 'text-sky-200/90' },
  education: { dot: 'bg-indigo-400', chip: 'border-indigo-400/40 bg-indigo-400/10', text: 'text-indigo-200/90' },
  finance: { dot: 'bg-teal-400', chip: 'border-teal-400/40 bg-teal-400/10', text: 'text-teal-200/90' },
  travel: { dot: 'bg-orange-400', chip: 'border-orange-400/40 bg-orange-400/10', text: 'text-orange-200/90' },
  relationships: { dot: 'bg-rose-400', chip: 'border-rose-400/40 bg-rose-400/10', text: 'text-rose-200/90' },
  media: { dot: 'bg-fuchsia-400', chip: 'border-fuchsia-400/40 bg-fuchsia-400/10', text: 'text-fuchsia-200/90' },
  technology: { dot: 'bg-cyan-400', chip: 'border-cyan-400/40 bg-cyan-400/10', text: 'text-cyan-200/90' },
  home: { dot: 'bg-violet-400', chip: 'border-violet-400/40 bg-violet-400/10', text: 'text-violet-200/90' },
  life: { dot: 'bg-white/50', chip: 'border-white/20 bg-white/[0.06]', text: 'text-white/70' },
  other: { dot: 'bg-white/25', chip: 'border-white/15 bg-white/[0.04]', text: 'text-white/50' },
  record: { dot: 'bg-slate-400', chip: 'border-slate-400/30 bg-slate-400/10', text: 'text-slate-300/80' },
}

// Eras are consecutive, so cycling the palette is enough to keep neighbours apart.
const ERA_BANDS = [
  'border-sky-400/25 bg-sky-400/[0.13] text-sky-100/75',
  'border-amber-400/25 bg-amber-400/[0.13] text-amber-100/75',
  'border-emerald-400/25 bg-emerald-400/[0.13] text-emerald-100/75',
  'border-violet-400/25 bg-violet-400/[0.13] text-violet-100/75',
  'border-rose-400/25 bg-rose-400/[0.13] text-rose-100/75',
  'border-teal-400/25 bg-teal-400/[0.13] text-teal-100/75',
]

/**
 * A date as a position on the axis. Timeline dates come in three precisions
 * (`2019`, `2019-06`, `2019-06-14`) and all three have to land somewhere
 * sensible, so the missing parts simply resolve to the start of the period.
 */
function yearFraction(date: string): number {
  const year = Number(date.slice(0, 4))
  if (!Number.isFinite(year)) return Number.NaN
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  const monthOffset = Number.isFinite(month) && month >= 1 && month <= 12 ? month - 1 : 0
  const dayOffset = Number.isFinite(day) && day >= 1 && day <= 31 ? (day - 1) / 31 : 0
  return year + (monthOffset + dayOffset) / 12
}

const EMPTY_CATEGORY_COUNTS: ReadonlyMap<TimelineCategory, number> = new Map()

/** Year spacing for the axis labels: at most a dozen, on a round interval. */
function axisStep(span: number): number {
  for (const step of [1, 2, 5, 10, 25, 50, 100]) {
    if (span / step <= 12) return step
  }
  return 200
}

interface TimelineRibbonProps {
  events: TimelineEvent[]
  eras: TimelineEra[]
  birthYear: number | null
  selectedYear: number | null
  onSelectYear: (year: number) => void
  /** Shared with the dated record below, so the page has one filter, not two. */
  selectedCategories: TimelineCategory[]
  onToggleCategory: (category: TimelineCategory) => void
  onClearCategories: () => void
}

export const TimelineRibbon: FC<TimelineRibbonProps> = ({
  events,
  eras,
  birthYear,
  selectedYear,
  onSelectYear,
  selectedCategories,
  onToggleCategory,
  onClearCategories,
}) => {
  const [hoverYear, setHoverYear] = useState<number | null>(null)
  const [mode, setMode] = useState<'count' | 'share'>('share')

  const model = useMemo(() => {
    // `record` events are the timeline's account of itself rather than events in
    // a life, and would otherwise dominate every bar.
    const dated = events.filter((event) => event.category !== 'record' && /^\d{4}/.test(event.startDate))
    if (dated.length === 0) return null

    const eventYears = dated.map((event) => Number(event.startDate.slice(0, 4)))
    const firstEventYear = Math.min(...eventYears)
    const lastEventYear = Math.max(...eventYears)
    // Anchor the axis on the birth year when Memory knows it: inherited items and
    // family papers predating a person are record rather than biography, and
    // letting them set the left edge squashes the actual life into a corner.
    const start = birthYear !== null && birthYear <= lastEventYear ? birthYear : firstEventYear
    const end = Math.max(lastEventYear, new Date().getFullYear())
    const total = end - start + 1

    const counts = new Map<number, { count: number; categories: Map<TimelineCategory, number> }>()
    let earlier = 0
    dated.forEach((event, index) => {
      const year = eventYears[index]
      if (year < start) {
        earlier += 1
        return
      }
      let bucket = counts.get(year)
      if (!bucket) {
        bucket = { count: 0, categories: new Map() }
        counts.set(year, bucket)
      }
      bucket.count += 1
      bucket.categories.set(event.category, (bucket.categories.get(event.category) ?? 0) + 1)
    })

    const columns = Array.from({ length: total }, (_, index) => {
      const year = start + index
      const bucket = counts.get(year)
      let dominant: TimelineCategory = 'other'
      let best = 0
      bucket?.categories.forEach((value, category) => {
        if (value > best) {
          best = value
          dominant = category
        }
      })
      const top = bucket
        ? Array.from(bucket.categories.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
        : []
      return {
        year,
        count: bucket?.count ?? 0,
        dominant,
        top,
        byCategory: bucket?.categories ?? EMPTY_CATEGORY_COUNTS,
      }
    })

    const maxCount = columns.reduce((peak, column) => Math.max(peak, column.count), 0)

    const seen = new Set(dated.map((event) => event.category))
    const present = TIMELINE_CATEGORIES.filter((category) => seen.has(category))

    const bands = eras
      .map((era, index) => {
        const from = yearFraction(era.startDate)
        const to = era.endDate ? yearFraction(era.endDate) : end + 1
        if (!Number.isFinite(from)) return null
        const left = Math.max(0, ((from - start) / total) * 100)
        const right = Math.min(100, (((Number.isFinite(to) ? to : end + 1) - start) / total) * 100)
        if (right <= 0 || left >= 100 || right - left <= 0) return null
        return { era, left, width: right - left, tone: ERA_BANDS[index % ERA_BANDS.length] }
      })
      .filter((band): band is NonNullable<typeof band> => band !== null)

    // Both ends are always labelled, so a round tick sitting almost on top of one
    // is dropped rather than left to overprint it.
    const step = axisStep(total)
    const ticks = [
      start,
      ...columns
        .map((column) => column.year)
        .filter((year) => year % step === 0 && year - start >= step / 2 && end - year >= step / 2),
      ...(end > start ? [end] : []),
    ]

    return { start, end, total, columns, maxCount, present, bands, ticks, earlier }
  }, [events, eras, birthYear])

  // Canonical order, so the stack keeps the same layering however the chips were
  // clicked. `record` is not in TIMELINE_CATEGORIES, which is also what keeps a
  // record-only selection from emptying the chart.
  const selected = useMemo(
    () => TIMELINE_CATEGORIES.filter((category) => selectedCategories.includes(category)),
    [selectedCategories]
  )

  // Absolute counts confound "more of this happened" with "more of it was written
  // down" — the record thickens sharply wherever a data source starts. Scaling
  // each year against its own total is what turns the chart into a trend.
  const peaks = useMemo(() => {
    if (!model || selected.length === 0) return { count: 0, share: 0 }
    let count = 0
    let share = 0
    for (const column of model.columns) {
      const sum = selected.reduce((total, category) => total + (column.byCategory.get(category) ?? 0), 0)
      count = Math.max(count, sum)
      if (column.count > 0) share = Math.max(share, sum / column.count)
    }
    return { count, share }
  }, [model, selected])

  if (!model) return null

  const { start, total, columns, maxCount, present, bands, ticks, earlier } = model
  const centerOf = (year: number) => ((year - start + 0.5) / total) * 100
  const hovered = hoverYear === null ? null : columns[hoverYear - start] ?? null
  const filtering = selected.length > 0
  const share = filtering && mode === 'share'

  /**
   * A segment's height as a percentage of the column.
   *
   * Both modes are scaled to their own peak rather than to a fixed ceiling: a
   * category that never exceeds a tenth of a year would otherwise draw as a flat
   * strip along the floor, which is unreadable exactly where the trend is. The
   * hover readout carries the true percentage so the scaling cannot mislead.
   */
  const segmentHeight = (column: (typeof columns)[number], category: TimelineCategory): number => {
    const count = column.byCategory.get(category) ?? 0
    if (count === 0) return 0
    if (share) {
      if (column.count <= 0 || peaks.share <= 0) return 0
      return (count / column.count / peaks.share) * 100
    }
    return peaks.count > 0 ? (count / peaks.count) * 100 : 0
  }

  return (
    <section className="mb-6 rounded-2xl border border-white/[0.07] bg-holmes-surface px-4 pb-3 pt-3">
      {bands.length > 0 && (
        <div className="relative mb-2 h-5">
          {bands.map((band, index) => (
            <div
              key={`${band.era.label}-${index}`}
              title={`${band.era.label} · ${band.era.startDate}${band.era.endDate ? ` – ${band.era.endDate}` : ' – present'}\n${band.era.summary}`}
              style={{ left: `${band.left}%`, width: `${band.width}%` }}
              className={`absolute inset-y-0 flex items-center overflow-hidden rounded-md border px-1.5 ${band.tone}`}
            >
              <span className="truncate text-[9px] leading-none font-serif-display">{band.era.label}</span>
            </div>
          ))}
        </div>
      )}

      <div>
        <div className="flex h-16 items-end gap-px" onMouseLeave={() => setHoverYear(null)}>
          {columns.map((column) => {
            const isSelectedYear = selectedYear === column.year
            const dim = selectedYear !== null && !isSelectedYear
            const height = maxCount > 0 && column.count > 0 ? Math.max(6, (column.count / maxCount) * 100) : 0
            const style = CATEGORY_STYLE[column.dominant] ?? CATEGORY_STYLE.other
            const selectedHasAny = selected.some((category) => (column.byCategory.get(category) ?? 0) > 0)
            return (
              <button
                key={column.year}
                type="button"
                disabled={column.count === 0}
                onMouseEnter={() => setHoverYear(column.year)}
                onFocus={() => setHoverYear(column.year)}
                onClick={() => onSelectYear(column.year)}
                aria-label={`${column.year}: ${column.count} event${column.count === 1 ? '' : 's'}`}
                className={`relative flex h-full min-w-0 flex-1 items-end rounded-t-sm outline-none transition-colors ${
                  column.count === 0
                    ? 'cursor-default'
                    : `cursor-pointer ${isSelectedYear ? 'bg-white/[0.09]' : 'hover:bg-white/[0.05]'}`
                }`}
              >
                {column.count === 0 ? (
                  <span className="h-px w-full bg-white/[0.06]" />
                ) : filtering ? (
                  // Stacked bottom-up in canonical category order. A year with none
                  // of the selected categories keeps its baseline rule, which is
                  // the point of the view: it reads as a real gap, not missing data.
                  <span className={`flex h-full w-full flex-col-reverse ${dim ? 'opacity-60' : 'opacity-85'}`}>
                    {selectedHasAny ? (
                      selected.map((category) => {
                        const segment = segmentHeight(column, category)
                        if (segment <= 0) return null
                        return (
                          <span
                            key={category}
                            style={{ height: `${segment}%`, minHeight: '2px' }}
                            className={`w-full ${CATEGORY_STYLE[category].dot}`}
                          />
                        )
                      })
                    ) : (
                      <span className="h-px w-full bg-white/[0.06]" />
                    )}
                  </span>
                ) : (
                  <span
                    style={{ height: `${height}%` }}
                    className={`w-full rounded-t-[2px] ${style.dot} transition-opacity ${
                      dim ? 'opacity-60' : 'opacity-85'
                    }`}
                  />
                )}
              </button>
            )
          })}
        </div>

        <div className="relative mt-1 h-4 border-t border-white/[0.09]">
          {ticks.map((year) => (
            <span
              key={year}
              style={{ left: `${centerOf(year)}%` }}
              className="absolute top-0 -translate-x-1/2 text-[9px] tabular-nums text-white/25"
            >
              {year}
            </span>
          ))}
          {birthYear !== null && birthYear >= start && birthYear <= model.end && (
            <span
              style={{ left: `${centerOf(birthYear)}%` }}
              className="absolute -top-[68px] h-[68px] w-px bg-white/15"
              title={`Born ${birthYear}`}
            />
          )}
        </div>
      </div>

      {/* The readout sits below the axis rather than floating over the bars: a
          tooltip above them would cover the era labels, which are the one row
          that has to stay legible while pointing at a year. */}
      <div className="relative mt-2 h-4 text-[10px] text-white/25">
        {hovered ? (
          <span
            style={{
              left: `${Math.min(88, Math.max(12, centerOf(hovered.year)))}%`,
            }}
            className="absolute -translate-x-1/2 whitespace-nowrap text-white/50"
          >
            <span className="tabular-nums text-white/80">{hovered.year}</span>
            <span className="text-white/25"> · </span>
            {hovered.count} event{hovered.count === 1 ? '' : 's'}
            {filtering ? (
              selected.map((category) => {
                const count = hovered.byCategory.get(category) ?? 0
                if (count === 0) return null
                return (
                  <span key={category} className={CATEGORY_STYLE[category].text}>
                    {' · '}
                    {category} {count}
                    {share && hovered.count > 0 ? ` (${Math.round((count / hovered.count) * 100)}%)` : ''}
                  </span>
                )
              })
            ) : hovered.top.length > 0 ? (
              <span className="text-white/35"> · {hovered.top.map(([category]) => category).join(', ')}</span>
            ) : null}
          </span>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span>
              {filtering
                ? share
                  ? `Each bar is what share of that year’s record went to the chosen categories, against a ${Math.round(
                      peaks.share * 100
                    )}% peak.`
                  : `Each bar is how many events of the chosen categories that year holds, against a peak of ${peaks.count}.`
                : earlier > 0
                  ? `${earlier} earlier record${earlier === 1 ? '' : 's'} predate ${start} and are not plotted`
                  : 'Bar height is how much of the record falls in that year; colour is its commonest category.'}
            </span>
            <span>Click a year to read it</span>
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] pt-2.5">
        {present.map((category) => {
          const active = selected.includes(category)
          const style = CATEGORY_STYLE[category]
          return (
            <button
              key={category}
              type="button"
              onClick={() => onToggleCategory(category)}
              aria-pressed={active}
              className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                active ? `${style.chip} ${style.text}` : 'border-white/10 bg-white/[0.02] text-white/35 hover:text-white/60'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${style.dot} ${active ? '' : 'opacity-40'}`} />
              {category}
            </button>
          )
        })}
        {filtering && (
          <>
            <button
              onClick={onClearCategories}
              className="cursor-pointer rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-white/35 transition-colors hover:text-white/70"
            >
              clear
            </button>
            {/* Only offered while filtering: a share view of everything is a flat
                wall of 100% bars. */}
            <div className="ml-auto flex items-center gap-0.5 text-[10px]">
              {(['share', 'count'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setMode(option)}
                  className={`cursor-pointer rounded-md px-2 py-0.5 transition-colors ${
                    mode === option
                      ? 'bg-holmes-primary/15 text-holmes-primary-light'
                      : 'text-white/35 hover:text-white/70'
                  }`}
                >
                  {option === 'share' ? 'Share of year' : 'Count'}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
