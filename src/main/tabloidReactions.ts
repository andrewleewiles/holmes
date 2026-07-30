// A thumbs-up in the Tabloid feed, offered to the memory profile.
//
// This is the part that compounds. A reaction changes the next feed on its own
// (it moves the input hash and it is named in both prompts), but writing it into
// `memory_fields` means the taste learned here also reaches chat, the timeline
// and every other feature that reads the profile.
//
// It goes through `applyMemoryCandidates`, and that choice is load-bearing: that
// function auto-fills ONLY a field that is empty and unlocked, and turns
// anything else into a pending suggestion for the user to accept on the Memory
// page. So a thumbs-up can never silently overwrite a "Movies and TV" list the
// user typed themselves.
//
// Only 'up' writes. `preferences` has `food_dislikes` but no media equivalent,
// and landing `movies_and_tv: ['not: X']` would corrupt a field that chat reads
// as a list of things they like. A thumbs-down lives in `tabloid_items.reaction`
// and in the two prompts, which is where it is actually useful.

import * as database from './database'
import { MEMORY_FIELDS } from '../shared/memoryCatalog'
import { TABLOID_MEMORY_FIELD_KEYS } from './tabloidPlanner'
import type { MemoryCandidate, TabloidItem } from '../shared/types'

const REACTION_CONFIDENCE = 0.6

/**
 * The value written is the CREATOR, not the title: `music_preferences` wants
 * "Mary Halvorson", not "Mary Halvorson - Amaryllis (Live at the Village
 * Vanguard)". The curator's suggested value is the fallback for a pick with no
 * channel attached.
 */
function reactionValue(item: TabloidItem, suggested: string | null): string {
  const creator = item.creator?.trim()
  if (creator) return creator.slice(0, 60)
  return (suggested ?? item.title).trim().slice(0, 60)
}

export function memoryCandidatesForReaction(item: TabloidItem, fieldKey: string | null): MemoryCandidate[] {
  if (!fieldKey) return []
  // Validated twice: once when the curator's reply was parsed, and again here,
  // because the stored value outlives the run that produced it.
  if (!TABLOID_MEMORY_FIELD_KEYS.includes(fieldKey)) return []
  const field = MEMORY_FIELDS.find((entry) => entry.key === fieldKey)
  if (!field) return []

  const value = reactionValue(item, null)
  if (!value) return []

  return [
    {
      fieldKey,
      // Every target field is a list, so 'merge' unions rather than replaces.
      value: field.valueType === 'list' ? [value] : value,
      confidence: REACTION_CONFIDENCE,
      rationale: 'Thumbs-up in the Tabloid feed',
      sources: [
        {
          type: 'tabloid-reaction',
          reference: `tabloid:${item.id}`,
          label: `Liked "${item.title}"${item.creator ? ` - ${item.creator}` : ''} in Play`,
          capturedAt: Date.now(),
        },
      ],
      mergeStrategy: field.valueType === 'list' ? 'merge' : 'supplement',
    },
  ]
}

/**
 * Which catalog field a liked video says something about.
 *
 * The curator chose this at pick time and it is stored on the row, so the
 * decision was made by something that had read the title, the channel and the
 * description — not by keyword-matching a title here.
 */
function fieldKeyForItem(item: TabloidItem): string | null {
  return database.getTabloidItemMemoryFieldKey(item.id)
}

/**
 * Idempotent by the `reaction_written_to_memory` flag: toggling the button five
 * times writes one candidate, not five suggestions the user has to dismiss.
 *
 * A pick the curator gave no field key records its reaction and writes nothing,
 * which is correct: not every good video says something durable about a taste.
 */
export function applyReactionToMemory(item: TabloidItem, fieldKeyOverride?: string | null): void {
  if (database.hasTabloidReactionBeenWritten(item.id)) return

  const fieldKey = fieldKeyOverride !== undefined ? fieldKeyOverride : fieldKeyForItem(item)
  const candidates = memoryCandidatesForReaction(item, fieldKey)
  if (candidates.length === 0) return

  try {
    database.applyMemoryCandidates(candidates)
    database.markTabloidReactionWritten(item.id)
  } catch {
    // A reaction that cannot reach the profile is still recorded on the item,
    // and the feed still learns from it. Not worth failing the click over.
  }
}
