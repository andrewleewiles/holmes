import { type CSSProperties, type FC } from 'react'
import { useAssistantIdentity } from '../hooks/useAssistantIdentity'
import { AssistantMark } from './AssistantMark'
// ?inline is load-bearing, not an optimisation: a packaged build serves the
// renderer over file://, and Chromium enforces CORS on CSS mask images, which
// blocks every file:// URL ("origin null"). data: URLs are exempt, so the
// strips must be inlined or the mark renders as nothing in the packaged app
// while looking fine against the dev server's http origin.
import thinkingStrip from '../../../assets/anim/holmes-thinking.png?inline'
import talkingStrip from '../../../assets/anim/holmes-talking.png?inline'
import idleStrip from '../../../assets/anim/holmes-idle-boil.png?inline'

export type MarkState = 'idle' | 'thinking' | 'talking'

/**
 * Frame counts must match the sprite strips emitted by anim/build-mark-anim.sh
 * — the strip is one row of square frames and the CSS sweep is derived from the
 * count, so a stale number here shows sliced-up frames rather than failing.
 */
const CLIPS: Record<MarkState, { src: string; frames: number }> = {
  thinking: { src: thinkingStrip, frames: 33 },
  talking: { src: talkingStrip, frames: 54 },
  // Idle is a "boil": the same symbol outline redrawn ten times with a small
  // wobble, so at rest the mark breathes rather than sitting dead. The frames
  // are generated procedurally from holmesSymbol.svg by anim/roughen-symbol.py
  // — no drawing and no model, the outline is just perturbed.
  idle: { src: idleStrip, frames: 10 },
}

/**
 * Playback rate. The AE comps were exported at 24fps; running them at 8 keeps
 * every drawn frame but stretches each loop 3x (talking 6.75s, thinking 4.13s),
 * which is the deliberate pace the mark is meant to have. Frames are not
 * dropped — this is a speed change, not a decimation.
 */
const FPS = 8

interface AnimatedMarkProps {
  state: MarkState
  className?: string
  style?: CSSProperties
  /** Paints the mark in an active character's colour. Defaults to the brand colour. */
  color?: string
}

/**
 * The assistant's mark, animating while it works: the thinking clip until the
 * first token lands, the talking clip while prose streams in, and a still frame
 * once the turn is done. Every state is drawn from the same source framing, so
 * switching between them never nudges the logo's size or position.
 *
 * The clips are alpha masks painted with --color-holmes-primary, which is what
 * unifies them on the brand colour — the strips themselves carry no colour.
 * A custom assistant icon has no clips to play, so it falls back to AssistantMark.
 */
export const AnimatedMark: FC<AnimatedMarkProps> = ({ state, className = '', style, color }) => {
  const { name, icon } = useAssistantIdentity()
  if (icon) return <AssistantMark className={className} style={style} color={color} />

  const { src, frames } = CLIPS[state]
  const animated = frames > 1

  return (
    <span
      role="img"
      aria-label={name}
      className={`holmes-mark ${animated ? 'holmes-mark--animated' : ''} ${className}`}
      style={{
        // The strips are alpha masks, so the character's colour is simply the
        // box behind them — the .holmes-mark rule's brand colour is the default.
        ...(color ? { backgroundColor: color } : {}),
        WebkitMaskImage: `url(${src})`,
        maskImage: `url(${src})`,
        // frames x 100% wide, so mask-position 0%->100% lands frame 0 -> frame N-1
        WebkitMaskSize: `${frames * 100}% 100%`,
        maskSize: `${frames * 100}% 100%`,
        ...(animated && {
          animationDuration: `${frames / FPS}s`,
          // jump-none is the variant that hits all N frames, both ends inclusive
          animationTimingFunction: `steps(${frames}, jump-none)`,
        }),
        ...style,
      }}
    />
  )
}
