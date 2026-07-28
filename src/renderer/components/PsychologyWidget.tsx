import { type FC } from 'react'
import type { BigFiveScores, PsychologyAnalysis } from '@shared/types'

interface PsychologyWidgetProps {
  analysis: PsychologyAnalysis
}

const ACCENT = '#8b5cf6'
const ACCENT_FILL = 'rgba(139, 92, 246, 0.16)'
const ACCENT_TRACK = 'rgba(139, 92, 246, 0.15)'
const SURFACE = '#2a2a27'

const TRAITS: Array<{ key: keyof BigFiveScores; label: string; short: string }> = [
  { key: 'openness', label: 'Openness', short: 'Opn' },
  { key: 'conscientiousness', label: 'Conscientiousness', short: 'Con' },
  { key: 'extraversion', label: 'Extraversion', short: 'Ext' },
  { key: 'agreeableness', label: 'Agreeableness', short: 'Agr' },
  { key: 'neuroticism', label: 'Neuroticism', short: 'Neu' },
]

function RadarChart({ scores }: { scores: BigFiveScores }) {
  const size = 150
  const cx = size / 2
  const cy = size / 2
  const r = 52
  const n = TRAITS.length
  const angleStep = (2 * Math.PI) / n

  const ringPoints = (level: number) =>
    TRAITS.map((_, i) => {
      const a = -Math.PI / 2 + i * angleStep
      return `${cx + r * level * Math.cos(a)},${cy + r * level * Math.sin(a)}`
    }).join(' ')

  const dataPoints = TRAITS.map((t, i) => {
    const a = -Math.PI / 2 + i * angleStep
    const val = (Math.max(0, Math.min(100, scores[t.key])) / 100) * r
    return { x: cx + val * Math.cos(a), y: cy + val * Math.sin(a) }
  })

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {[0.25, 0.5, 0.75, 1].map((level) => (
        <polygon key={level} points={ringPoints(level)} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
      ))}
      {TRAITS.map((_, i) => {
        const a = -Math.PI / 2 + i * angleStep
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={cx + r * Math.cos(a)}
            y2={cy + r * Math.sin(a)}
            stroke="rgba(255,255,255,0.05)"
            strokeWidth="1"
          />
        )
      })}
      <polygon
        points={dataPoints.map((p) => `${p.x},${p.y}`).join(' ')}
        fill={ACCENT_FILL}
        stroke={ACCENT}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {dataPoints.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3.5" fill={ACCENT} stroke={SURFACE} strokeWidth="2" />
      ))}
      {TRAITS.map((t, i) => {
        const a = -Math.PI / 2 + i * angleStep
        const labelR = r + 15
        return (
          <text
            key={t.key}
            x={cx + labelR * Math.cos(a)}
            y={cy + labelR * Math.sin(a)}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="rgba(255,255,255,0.45)"
            fontSize="9"
          >
            {t.short}
          </text>
        )
      })}
    </svg>
  )
}

function TraitBar({ label, score }: { label: string; score: number }) {
  const clamped = Math.max(0, Math.min(100, score))
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-white/60 truncate">{label}</span>
        <span className="text-[11px] text-white/40 tabular-nums shrink-0">{Math.round(clamped)}</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: ACCENT_TRACK }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.max(2, clamped)}%`, backgroundColor: ACCENT }}
        />
      </div>
    </div>
  )
}

function RingGauge({ label, value, description }: { label: string; value: number; description?: string }) {
  const size = 56
  const strokeWidth = 5
  const r = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <div className="flex flex-col items-center gap-2 bg-white/5 rounded-xl p-3" title={description}>
      <div className="relative">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={ACCENT_TRACK} strokeWidth={strokeWidth} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={ACCENT}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - clamped / 100)}
            className="transition-all duration-500"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-white/85">
          {Math.round(clamped)}
        </span>
      </div>
      <span className="text-[10px] text-white/40 uppercase tracking-wider text-center leading-tight">{label}</span>
    </div>
  )
}

export const PsychologyWidget: FC<PsychologyWidgetProps> = ({ analysis }) => {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-6">
        <div className="shrink-0">
          <RadarChart scores={analysis.bigFive} />
        </div>
        <div className="flex-1 space-y-2 min-w-0">
          <h3 className="text-xs font-medium text-white/70 uppercase tracking-wider">Big Five</h3>
          <div className="space-y-1.5">
            {TRAITS.map((t) => (
              <TraitBar key={t.key} label={t.label} score={analysis.bigFive[t.key]} />
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <RingGauge label="Emotional intelligence" value={analysis.emotionalIntelligence} />
        <RingGauge label="Well-being" value={analysis.wellBeing} />
        <RingGauge
          label={analysis.cognitiveStyle.label}
          value={analysis.cognitiveStyle.score}
          description={analysis.cognitiveStyle.description}
        />
      </div>

      <p className="text-xs text-white/50 leading-relaxed">{analysis.summary}</p>
    </div>
  )
}
