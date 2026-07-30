import { handleKey, isPseudonymName, personKey, personTokens } from './people'
import type {
  PersonAliasKind,
  PersonAliasOrigin,
  PersonIdentityBasis,
  PersonMentionInput,
  PersonOverride,
  PersonRelation,
  PersonSeed,
  PersonPlatform,
  PersonSeedSource,
  PersonSourceType,
  PersonStatus,
} from './types'

/**
 * Identity resolution, as a pure function.
 *
 * The governing rule of this subsystem is that a *mention* is never the same
 * object as a *person*. Mentions are cheap, append-only facts about what one
 * source said. A person is a pure function of (mentions + seeds + overrides)
 * that can be thrown away and recomputed at any time. Keeping the resolver
 * free of the database is what makes that property testable, and it is why a
 * user correction is stored as an override that is re-applied on every rebuild
 * rather than as an UPDATE the next rebuild would silently undo.
 *
 * The bias throughout is toward UNDER-merging. Two rows for one person is a
 * cosmetic annoyance the user can fix in one click, and no evidence is lost.
 * Fusing two real people into one produces a confident dossier about a person
 * who does not exist, and then injects it into every conversation. The two
 * failures are not symmetric, so the cascade refuses whenever it is unsure.
 */

/** How much a source's claim about a person is worth. Mirrors SOURCE_CONFIDENCE in timeline.ts. */
export const PERSON_SOURCE_CONFIDENCE: Record<PersonSourceType, number> = {
  manual: 1,
  contacts: 1,
  memory: 0.95,
  messaging: 0.9,
  // A conversation outranks a document here, the reverse of the timeline's order:
  // the user naming someone in chat is a first-person assertion about their own
  // life, while a document naming someone may mean its author or a stranger.
  conversation: 0.8,
  document: 0.75,
  health: 0.75,
  activity: 0.75,
  finances: 0.7,
  folder: 0.7,
  project: 0.65,
  'user-context': 0.6,
  'relationship-analysis': 0.5,
}

/** Lower wins when two sources disagree about a relation. */
const RELATION_PRIORITY: Record<PersonSourceType, number> = {
  manual: 0,
  memory: 1,
  contacts: 2,
  messaging: 3,
  conversation: 4,
  document: 5,
  health: 6,
  activity: 7,
  finances: 8,
  folder: 9,
  project: 10,
  'user-context': 11,
  'relationship-analysis': 12,
}

/**
 * Relations that may never describe the same person. This matrix is a VETO, never
 * a reason to merge, and it is deliberately weak: too strong a matrix splits real
 * people, and people genuinely change roles — a colleague becomes a friend, a
 * trainer becomes a friend, a partner becomes family. Only the walls that cannot
 * be crossed are listed.
 */
const INCOMPATIBLE: Array<[PersonRelation, PersonRelation]> = [
  ['self', 'family'],
  ['self', 'partner'],
  ['self', 'friend'],
  ['self', 'colleague'],
  ['self', 'client'],
  ['self', 'professional'],
  ['self', 'community'],
  ['self', 'acquaintance'],
  ['self', 'public'],
  ['public', 'family'],
  ['public', 'partner'],
  ['public', 'colleague'],
  ['public', 'client'],
  ['public', 'community'],
  ['family', 'client'],
]

const INCOMPATIBLE_KEYS = new Set(INCOMPATIBLE.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]))

export function relationsCompatible(a: PersonRelation, b: PersonRelation): boolean {
  if (a === b) return true
  if (a === 'unknown' || b === 'unknown') return true
  return !INCOMPATIBLE_KEYS.has(`${a}|${b}`)
}

/**
 * How much each way of establishing an identity is worth.
 *
 * Distinct from `PERSON_SOURCE_CONFIDENCE`, which grades how much a SOURCE's
 * claim about a person is worth. This grades something else entirely: how sure
 * we are that the row is one real person rather than two people fused or one
 * person guessed at. A dossier assembled from mentions joined on a shared first
 * name is exactly as authoritative-sounding as one joined on a phone number, and
 * before this there was nothing in the record to tell them apart.
 */
export const IDENTITY_BASIS_CONFIDENCE: Record<PersonIdentityBasis, number> = {
  // The user asserted this identity: a Contacts card, a Memory field, or a
  // correction they made by hand.
  asserted: 1,
  // Joined on an email address or a phone number.
  handle: 0.9,
  // Joined on a full normalized name, or on a co-reference the material stated.
  'name-exact': 0.75,
  // Joined on a shortened or initialled form that fitted exactly one person.
  'name-partial': 0.55,
  // Nothing to join to: one name from one source, standing alone.
  unresolved: 0.45,
  // Several people fitted and the resolver refused to choose. Quarantined.
  ambiguous: 0.2,
}

/** Which cascade rule produced which basis. R3 is graded as the weaker of the two things it can be. */
function basisForRule(rule: string): PersonIdentityBasis {
  if (rule.endsWith('-ambiguous')) return 'ambiguous'
  if (rule === 'R0') return 'asserted'
  if (rule === 'R1') return 'handle'
  if (rule === 'R2' || rule === 'R3') return 'name-exact'
  if (rule === 'R4' || rule === 'R5') return 'name-partial'
  return 'unresolved'
}

function basisForSeed(seedSource: PersonSeedSource | null): PersonIdentityBasis | null {
  if (seedSource === 'contacts' || seedSource === 'memory') return 'asserted'
  // A messaging seed is a counterparty the message store identified by handle.
  if (seedSource === 'messaging') return 'handle'
  return null
}

/** The weaker of two bases — the one that governs how much the record can be trusted. */
function weakerBasis(a: PersonIdentityBasis, b: PersonIdentityBasis): PersonIdentityBasis {
  return IDENTITY_BASIS_CONFIDENCE[a] <= IDENTITY_BASIS_CONFIDENCE[b] ? a : b
}

/** Below this the chat block says so rather than presenting the person as settled. */
export const MIN_IDENTITY_CONFIDENCE_FOR_CERTAINTY = 0.75

/** A person appears in the widget and the chat block at this score. */
export const MIN_SCORE_FOR_PERSON = 3
/** A person earns an LLM-generated dossier at this score. */
export const MIN_SCORE_FOR_DOSSIER = 8

export function personScore(mentionCount: number, messageCount: number): number {
  return mentionCount + Math.min(20, Math.floor(messageCount / 50))
}

export interface ResolvableMention extends PersonMentionInput {
  mentionKey: string
}

export interface ResolvedMention extends ResolvableMention {
  nameKey: string
  handleKey: string | null
  personKey: string
  /** Which cascade rule attached it. The whole diagnostic trail for a bad merge. */
  resolutionRule: string
}

export interface ResolvedAlias {
  alias: string
  aliasKey: string
  kind: PersonAliasKind
  origin: PersonAliasOrigin
}

export interface ResolvedPerson {
  personKey: string
  displayName: string
  relation: PersonRelation
  role: string
  status: PersonStatus
  isPseudonym: boolean
  isSelf: boolean
  seedSource: PersonSeedSource | null
  mentionCount: number
  sourceCount: number
  messageCount: number
  sentCount: number
  daysActive: number
  firstSeen: string | null
  lastSeen: string | null
  score: number
  confidence: number
  /**
   * How this identity was established — the WEAKEST link in it, not the
   * strongest. A Contacts-seeded person who also absorbed a mention matched on
   * initials alone reads `name-partial`, because that mention is the one that
   * could have brought a stranger into the record.
   */
  identityBasis: PersonIdentityBasis
  identityConfidence: number
  projectIds: string[]
  platforms: PersonPlatform[]
  aliases: ResolvedAlias[]
}

export interface ResolveInput {
  mentions: ResolvableMention[]
  seeds: PersonSeed[]
  overrides: PersonOverride[]
}

export interface ResolveResult {
  people: ResolvedPerson[]
  mentions: ResolvedMention[]
  ambiguous: number
  overridesApplied: number
}

interface WorkingPerson {
  personKey: string
  displayName: string
  displayTokens: string[]
  seedRelation: PersonRelation
  seedRole: string
  seedSource: PersonSeedSource | null
  isPseudonym: boolean
  messageCount: number
  sentCount: number
  daysActive: number
  firstSeen: string | null
  lastSeen: string | null
  seedConfidence: number
  platforms: Map<string, PersonPlatform>
  ambiguous: boolean
  aliases: Map<string, ResolvedAlias>
  nameKeys: Set<string>
  handleKeys: Set<string>
}

function addAlias(person: WorkingPerson, alias: string, kind: PersonAliasKind, origin: PersonAliasOrigin): void {
  const trimmed = (alias ?? '').trim()
  if (!trimmed) return
  const key = kind === 'name' ? personKey(trimmed) : (handleKey(trimmed) ?? trimmed.toLowerCase())
  if (!key) return
  if (kind === 'name') person.nameKeys.add(key)
  else person.handleKeys.add(key)
  const mapKey = `${kind}:${key}`
  if (!person.aliases.has(mapKey)) {
    person.aliases.set(mapKey, { alias: trimmed, aliasKey: key, kind, origin })
  }
}

/**
 * Collapses mentions that share a mention key.
 *
 * A mention key is (source, normalized name), so two of them means one source
 * named one person twice — a PEOPLE block listing both "Sarah Klein" and "sarah
 * klein", or simply repeating a line. Nothing upstream prevents that, and left
 * alone it both inflates `mentionCount` (the score is a mention count) and
 * violates the UNIQUE index the mentions table is stored under, which fails the
 * whole rebuild transaction over one duplicated line.
 *
 * The survivor is chosen by information, not by arrival order: the resolver
 * guarantees two runs over the same evidence produce byte-identical people, so
 * the tie-break has to be on content rather than on harvest order.
 */
function dedupeMentions(mentions: ResolvableMention[]): ResolvableMention[] {
  const best = new Map<string, ResolvableMention>()
  for (const mention of mentions) {
    const existing = best.get(mention.mentionKey)
    if (!existing) {
      best.set(mention.mentionKey, mention)
      continue
    }
    const winner = richerMention(existing, mention)
    const loser = winner === existing ? mention : existing
    // The aka lists are the one field where a duplicate can carry something the
    // survivor does not: it is what R3 co-reference resolution runs on.
    const aka = [...winner.aka]
    for (const alias of loser.aka) {
      if (!aka.some((known) => known.toLowerCase() === alias.toLowerCase())) aka.push(alias)
    }
    best.set(mention.mentionKey, aka.length === winner.aka.length ? winner : { ...winner, aka })
  }
  return [...best.values()]
}

function richerMention(a: ResolvableMention, b: ResolvableMention): ResolvableMention {
  const rank = (mention: ResolvableMention): number =>
    (mention.relation !== 'unknown' ? 4 : 0) + (mention.role ? 2 : 0) + (mention.evidence ? 1 : 0)
  const byRank = rank(b) - rank(a)
  if (byRank !== 0) return byRank > 0 ? b : a
  const byEvidence = b.evidence.length - a.evidence.length
  if (byEvidence !== 0) return byEvidence > 0 ? b : a
  // Nothing distinguishes them by content, so fall back to something stable.
  return `${b.rawName} ${b.relation} ${b.role}` < `${a.rawName} ${a.relation} ${a.role}` ? b : a
}

/** Two names describe one person when one is an initialled or shortened form of the other. */
function nameCompatible(a: string[], b: string[]): boolean {
  return sequenceCompatible(a, b) || sequenceCompatible(b, a)
}

function sequenceCompatible(short: string[], long: string[]): boolean {
  if (short.length === 0 || long.length === 0) return false
  if (short.length > long.length) return false
  // Given names must agree outright — matching only on a surname would merge
  // every member of a family into one person.
  if (short[0] !== long[0]) return false
  let cursor = 1
  for (let index = 1; index < short.length; index += 1) {
    const token = short[index]
    let found = false
    while (cursor < long.length) {
      const candidate = long[cursor]
      cursor += 1
      if (candidate === token || (token.length === 1 && candidate.startsWith(token))) {
        found = true
        break
      }
    }
    if (!found) return false
  }
  return true
}

function seedKeyFor(seed: PersonSeed): string {
  return seed.personKey
}

function newerDate(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

function olderDate(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a < b ? a : b
}

function mergeSeedInto(person: WorkingPerson, seed: PersonSeed): void {
  person.messageCount += seed.messageCount
  person.sentCount += seed.sentCount
  person.daysActive = Math.max(person.daysActive, seed.daysActive)
  person.firstSeen = olderDate(person.firstSeen, seed.firstSeen)
  person.lastSeen = newerDate(person.lastSeen, seed.lastSeen)
  person.seedConfidence = Math.max(person.seedConfidence, seed.confidence)
  // Two seeds for one person means two platforms, or the same platform seen
  // twice; either way the breakdown is summed per provider, never collapsed.
  for (const platform of seed.platforms) {
    const existing = person.platforms.get(platform.provider)
    if (existing) {
      existing.messageCount += platform.messageCount
      existing.sentCount += platform.sentCount
      existing.daysActive = Math.max(existing.daysActive, platform.daysActive)
      existing.firstSeen = olderDate(existing.firstSeen, platform.firstSeen)
      existing.lastSeen = newerDate(existing.lastSeen, platform.lastSeen)
    } else {
      person.platforms.set(platform.provider, { ...platform })
    }
  }
  if (person.seedRelation === 'unknown' && seed.relation !== 'unknown') {
    person.seedRelation = seed.relation
    person.seedRole = seed.role
  }
  for (const alias of seed.aliases) addAlias(person, alias.alias, alias.kind, 'seed')
  addAlias(person, seed.displayName, 'name', 'seed')
}

function createPerson(personKeyValue: string, displayName: string): WorkingPerson {
  return {
    personKey: personKeyValue,
    displayName,
    displayTokens: personTokens(displayName),
    seedRelation: 'unknown',
    seedRole: '',
    seedSource: null,
    isPseudonym: isPseudonymName(displayName),
    messageCount: 0,
    sentCount: 0,
    daysActive: 0,
    firstSeen: null,
    lastSeen: null,
    seedConfidence: 0,
    platforms: new Map(),
    ambiguous: false,
    aliases: new Map(),
    nameKeys: new Set(),
    handleKeys: new Set(),
  }
}

export function resolvePeople(input: ResolveInput): ResolveResult {
  const people = new Map<string, WorkingPerson>()
  const byHandle = new Map<string, string>()
  const byName = new Map<string, Set<string>>()
  let overridesApplied = 0

  const indexName = (key: string, personKeyValue: string): void => {
    if (!key) return
    const bucket = byName.get(key)
    if (bucket) bucket.add(personKeyValue)
    else byName.set(key, new Set([personKeyValue]))
  }

  const indexPerson = (person: WorkingPerson): void => {
    for (const key of person.nameKeys) indexName(key, person.personKey)
    for (const key of person.handleKeys) {
      if (!byHandle.has(key)) byHandle.set(key, person.personKey)
    }
  }

  // --- 1. The seed spine, built before any model output is consulted ---------
  // Contacts first: the user asserted those identities themselves, and they are
  // the only seeds carrying handles, so later seeds can attach to them by name.
  const seedOrder: Record<PersonSeedSource, number> = { contacts: 0, memory: 1, messaging: 2 }
  const seeds = [...input.seeds].sort((a, b) => {
    const bySource = seedOrder[a.seedSource] - seedOrder[b.seedSource]
    return bySource !== 0 ? bySource : a.personKey.localeCompare(b.personKey)
  })

  for (const seed of seeds) {
    const nameKeyValue = personKey(seed.displayName)
    let target: WorkingPerson | undefined

    for (const alias of seed.aliases) {
      const key = handleKey(alias.alias)
      if (key && byHandle.has(key)) {
        target = people.get(byHandle.get(key) as string)
        break
      }
    }
    if (!target && nameKeyValue && !seed.isPseudonym) {
      const candidates = byName.get(nameKeyValue)
      // Exactly one candidate, or the ambiguity is real and both stay separate.
      if (candidates?.size === 1) {
        const candidate = people.get([...candidates][0] as string)
        if (candidate && relationsCompatible(candidate.seedRelation, seed.relation)) target = candidate
      }
    }

    if (target) {
      mergeSeedInto(target, seed)
      indexPerson(target)
      continue
    }

    const person = createPerson(seedKeyFor(seed), seed.displayName)
    person.seedSource = seed.seedSource
    person.isPseudonym = seed.isPseudonym
    person.seedRelation = seed.relation
    person.seedRole = seed.role
    mergeSeedInto(person, seed)
    people.set(person.personKey, person)
    indexPerson(person)
  }

  // --- 2. Overrides that change the spine -----------------------------------
  const pinByMention = new Map<string, string | null>()
  const mergeMap = new Map<string, string>()
  const ignored = new Set<string>()
  const relationOverride = new Map<string, PersonRelation>()

  for (const override of input.overrides) {
    if (override.kind === 'pin') pinByMention.set(override.subject, override.target)
    else if (override.kind === 'merge' && override.target) mergeMap.set(override.subject, override.target)
    else if (override.kind === 'ignore') ignored.add(override.subject)
    else if (override.kind === 'relation' && override.target) relationOverride.set(override.subject, override.target as PersonRelation)
  }

  // --- 3. The cascade -------------------------------------------------------
  // Mentions are sorted first so the result never depends on harvest order: two
  // runs over the same evidence must produce byte-identical people.
  const ordered = dedupeMentions(input.mentions).sort((a, b) => a.mentionKey.localeCompare(b.mentionKey))
  const resolved: ResolvedMention[] = []
  const ambiguousKeys = new Set<string>()

  for (const mention of ordered) {
    const nameKeyValue = personKey(mention.rawName)
    const handleKeyValue = handleKey(mention.rawName)
    const tokens = personTokens(mention.rawName)

    let targetKey: string | null = null
    let rule = 'R7'

    // R0 — a user correction always wins.
    if (pinByMention.has(mention.mentionKey)) {
      targetKey = pinByMention.get(mention.mentionKey) ?? null
      rule = 'R0'
      overridesApplied += 1
    }

    // R1 — a handle is a far stronger identifier than a name.
    if (!targetKey && handleKeyValue && byHandle.has(handleKeyValue)) {
      targetKey = byHandle.get(handleKeyValue) as string
      rule = 'R1'
    }

    // R2 — exact name key, including any alias. This is what resolves "Mom":
    // the Contacts record on this machine is literally named "Mom".
    if (!targetKey && nameKeyValue) {
      const candidates = [...(byName.get(nameKeyValue) ?? [])].filter((key) =>
        relationsCompatible(people.get(key)?.seedRelation ?? 'unknown', mention.relation)
      )
      if (candidates.length === 1) {
        targetKey = candidates[0]
        rule = 'R2'
      } else if (candidates.length > 1) {
        targetKey = null
        rule = 'R2-ambiguous'
      }
    }

    // R3 — the model saw a co-reference this material makes and we cannot.
    if (!targetKey && rule !== 'R2-ambiguous') {
      for (const alias of mention.aka) {
        const aliasHandle = handleKey(alias)
        if (aliasHandle && byHandle.has(aliasHandle)) {
          targetKey = byHandle.get(aliasHandle) as string
          rule = 'R3'
          break
        }
        const aliasName = personKey(alias)
        const candidates = [...(byName.get(aliasName) ?? [])]
        if (candidates.length === 1) {
          targetKey = candidates[0]
          rule = 'R3'
          break
        }
      }
    }

    // R4/R5 — shortened and initialled forms, only when exactly one person fits.
    if (!targetKey && rule !== 'R2-ambiguous' && tokens.length > 0) {
      const candidates: string[] = []
      for (const person of people.values()) {
        if (person.isPseudonym) continue
        if (!relationsCompatible(person.seedRelation, mention.relation)) continue
        if (nameCompatible(tokens, person.displayTokens)) candidates.push(person.personKey)
      }
      if (candidates.length === 1) {
        targetKey = candidates[0]
        rule = tokens.length >= 2 ? 'R4' : 'R5'
      } else if (candidates.length > 1) {
        targetKey = null
        rule = tokens.length >= 2 ? 'R4-ambiguous' : 'R5-ambiguous'
      }
    }

    if (!targetKey) {
      // Nothing matched, or too much matched. Either way this mention gets its
      // own person; an ambiguous one is quarantined under a `bare:` key so every
      // later mention of the same unresolvable name lands in the same place.
      const isAmbiguous = rule.endsWith('-ambiguous')
      const fallbackKey = isAmbiguous
        ? `bare:${nameKeyValue || mention.rawName.toLowerCase()}`
        : handleKeyValue
          ? `handle:${handleKeyValue}`
          : `name:${nameKeyValue || mention.rawName.toLowerCase()}`
      targetKey = fallbackKey
      let person = people.get(targetKey)
      if (!person) {
        person = createPerson(targetKey, mention.rawName)
        people.set(targetKey, person)
      }
      if (isAmbiguous) {
        person.ambiguous = true
        ambiguousKeys.add(targetKey)
      }
      addAlias(person, mention.rawName, 'name', 'derived')
      if (handleKeyValue) addAlias(person, mention.rawName, 'handle', 'derived')
      indexPerson(person)
    } else {
      const person = people.get(targetKey)
      if (person) {
        // A resolved mention teaches the index the name it used, so the next
        // spelling of it resolves on R2 instead of falling through to R4/R5.
        addAlias(person, mention.rawName, 'name', 'derived')
        for (const alias of mention.aka) {
          addAlias(person, alias, handleKey(alias) ? 'handle' : 'name', 'derived')
        }
        indexPerson(person)
      }
    }

    resolved.push({
      ...mention,
      nameKey: nameKeyValue,
      handleKey: handleKeyValue,
      personKey: targetKey,
      resolutionRule: rule,
    })
  }

  // --- 4. Merge overrides, re-applied every rebuild -------------------------
  const redirect = (key: string): string => {
    let current = key
    for (let hops = 0; hops < 8; hops += 1) {
      const next = mergeMap.get(current)
      if (!next || next === current) break
      current = next
    }
    return current
  }

  const foldInto = (target: WorkingPerson, source: WorkingPerson): void => {
    for (const alias of source.aliases.values()) addAlias(target, alias.alias, alias.kind, alias.origin)
    target.messageCount += source.messageCount
    target.sentCount += source.sentCount
    target.daysActive = Math.max(target.daysActive, source.daysActive)
    target.firstSeen = olderDate(target.firstSeen, source.firstSeen)
    target.lastSeen = newerDate(target.lastSeen, source.lastSeen)
    // Linking a handle to a known person is exactly how a second platform joins
    // their record, so the breakdown has to travel with the merge.
    for (const platform of source.platforms.values()) {
      const existing = target.platforms.get(platform.provider)
      if (existing) {
        existing.messageCount += platform.messageCount
        existing.sentCount += platform.sentCount
        existing.daysActive = Math.max(existing.daysActive, platform.daysActive)
        existing.firstSeen = olderDate(existing.firstSeen, platform.firstSeen)
        existing.lastSeen = newerDate(existing.lastSeen, platform.lastSeen)
      } else {
        target.platforms.set(platform.provider, { ...platform })
      }
    }
  }

  // People are folded BEFORE mentions are redirected, and independently of them.
  // Handle linking routinely joins two messaging seeds that carry no document
  // mentions at all, and a mention-driven pass would silently do nothing for
  // exactly the case the feature exists to serve.
  for (const [key, person] of [...people.entries()]) {
    const redirected = redirect(key)
    if (redirected === key) continue
    const target = people.get(redirected)
    if (!target) continue
    foldInto(target, person)
    people.delete(key)
    overridesApplied += 1
  }

  for (const mention of resolved) {
    const redirected = redirect(mention.personKey)
    if (redirected !== mention.personKey) mention.personKey = redirected
  }

  // --- 5. Aggregate ---------------------------------------------------------
  const byPerson = new Map<string, ResolvedMention[]>()
  for (const mention of resolved) {
    const bucket = byPerson.get(mention.personKey)
    if (bucket) bucket.push(mention)
    else byPerson.set(mention.personKey, [mention])
  }

  const out: ResolvedPerson[] = []
  for (const person of people.values()) {
    const mentions = byPerson.get(person.personKey) ?? []
    const sourceRefs = new Set(mentions.map((mention) => mention.sourceRef))
    const projectIds = [...new Set(mentions.map((mention) => mention.projectId).filter((id): id is string => Boolean(id)))].sort()

    // Relation and role are chosen independently. A Contacts seed asserts who
    // someone is without ever saying what they are, so letting its relation set
    // the bar for the role too would throw away the one field a document is
    // actually good at ("mother", "physical therapist").
    let relation = person.seedRelation
    let role = person.seedRole
    const seedPriority = person.seedSource ? RELATION_PRIORITY[person.seedSource] : Number.MAX_SAFE_INTEGER
    let relationBest = relation !== 'unknown' ? seedPriority : Number.MAX_SAFE_INTEGER
    let roleBest = role ? seedPriority : Number.MAX_SAFE_INTEGER
    for (const mention of mentions) {
      const priority = RELATION_PRIORITY[mention.sourceType]
      if (mention.relation !== 'unknown' && priority < relationBest) {
        relationBest = priority
        relation = mention.relation
      }
      if (mention.role && priority < roleBest) {
        roleBest = priority
        role = mention.role
      }
    }

    const forced = relationOverride.get(person.personKey)
    if (forced) {
      relation = forced
      overridesApplied += 1
    }

    // The most complete spelling anyone used, unless a seed already named them.
    let displayName = person.displayName
    if (!person.seedSource) {
      for (const mention of mentions) {
        const candidateTokens = personTokens(mention.rawName)
        const currentTokens = personTokens(displayName)
        if (candidateTokens.length > currentTokens.length) displayName = mention.rawName
        else if (candidateTokens.length === currentTokens.length && mention.rawName.length > displayName.length) displayName = mention.rawName
      }
    }

    const mentionCount = mentions.length
    const score = personScore(mentionCount, person.messageCount)
    const isSelf = relation === 'self'

    let status: PersonStatus = 'unverified'
    if (ignored.has(person.personKey)) status = 'ignored'
    else if (person.ambiguous) status = 'ambiguous'
    else if (person.seedSource || score >= MIN_SCORE_FOR_PERSON) status = 'confirmed'

    const confidence = Math.max(
      person.seedConfidence,
      ...mentions.map((mention) => mention.confidence),
      0
    )

    // A seed anchors the identity; every mention attached to it can only weaken
    // that anchor, never strengthen it. A person with neither a seed nor a
    // mention cannot happen (both are the only ways a person is created), but
    // `unresolved` is the honest floor if one ever did.
    let identityBasis: PersonIdentityBasis = person.ambiguous
      ? 'ambiguous'
      : basisForSeed(person.seedSource) ?? 'unresolved'
    if (!person.ambiguous) {
      for (const mention of mentions) identityBasis = weakerBasis(identityBasis, basisForRule(mention.resolutionRule))
    }

    out.push({
      personKey: person.personKey,
      displayName,
      relation,
      role,
      status,
      isPseudonym: person.isPseudonym,
      isSelf,
      seedSource: person.seedSource,
      mentionCount,
      sourceCount: sourceRefs.size,
      messageCount: person.messageCount,
      sentCount: person.sentCount,
      daysActive: person.daysActive,
      firstSeen: person.firstSeen,
      lastSeen: person.lastSeen,
      score,
      confidence,
      identityBasis,
      identityConfidence: IDENTITY_BASIS_CONFIDENCE[identityBasis],
      projectIds,
      platforms: [...person.platforms.values()].sort((a, b) => b.messageCount - a.messageCount),
      aliases: [...person.aliases.values()].sort((a, b) => a.aliasKey.localeCompare(b.aliasKey)),
    })
  }

  // Ties on the capped score are common — every correspondent above 1,000 messages
  // saturates it — so fall through to real volume before the name, or the ordering
  // among the most important people would be alphabetical.
  out.sort((a, b) =>
    (b.score - a.score) ||
    (b.messageCount - a.messageCount) ||
    (b.sourceCount - a.sourceCount) ||
    a.personKey.localeCompare(b.personKey))

  return { people: out, mentions: resolved, ambiguous: ambiguousKeys.size, overridesApplied }
}

export interface DuplicateGroup {
  /** Person keys in the group, sorted, so the grouping is stable across runs. */
  personKeys: string[]
  /** Their display names, in the same order, for a message the user can read. */
  displayNames: string[]
}

/**
 * Finds rows that may be one person the cascade refused to merge.
 *
 * The resolver's bias toward under-merging is correct and stays: fusing two real
 * people produces a confident dossier about somebody who does not exist. But the
 * cost of that bias was silent — two rows for one person, presented as two
 * people, with nothing marking them as the same candidate. This names the
 * candidates without merging them, which is the honest middle: the People page
 * can offer the one-click merge, and the chat block can say "these two may be
 * the same person" instead of implying they are not.
 *
 * Pure and read-only: it groups on the same name compatibility the cascade uses,
 * so a group here is precisely a merge the cascade considered and declined.
 */
export function findPossibleDuplicateGroups(
  people: Array<{
    personKey: string
    displayName: string
    relation: PersonRelation
    isPseudonym: boolean
  }>
): DuplicateGroup[] {
  // A pseudonym has no name to compare, and `self` is the archive's owner.
  const candidates = people.filter((person) => !person.isPseudonym && person.relation !== 'self')
  const parent = new Map<string, string>(candidates.map((person) => [person.personKey, person.personKey]))

  const find = (key: string): string => {
    let root = key
    while (parent.get(root) !== root) root = parent.get(root) as string
    // Path compression keeps this linear over the thousands of rows a real
    // archive produces.
    let cursor = key
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) as string
      parent.set(cursor, root)
      cursor = next
    }
    return root
  }

  const tokens = new Map(candidates.map((person) => [person.personKey, personTokens(person.displayName)]))
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i]
      const b = candidates[j]
      if (!relationsCompatible(a.relation, b.relation)) continue
      if (!nameCompatible(tokens.get(a.personKey) ?? [], tokens.get(b.personKey) ?? [])) continue
      const rootA = find(a.personKey)
      const rootB = find(b.personKey)
      if (rootA !== rootB) parent.set(rootA, rootB)
    }
  }

  const byRoot = new Map<string, string[]>()
  for (const person of candidates) {
    const root = find(person.personKey)
    const bucket = byRoot.get(root)
    if (bucket) bucket.push(person.personKey)
    else byRoot.set(root, [person.personKey])
  }

  const nameOf = new Map(candidates.map((person) => [person.personKey, person.displayName]))
  return [...byRoot.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const personKeys = [...group].sort()
      return { personKeys, displayNames: personKeys.map((key) => nameOf.get(key) ?? key) }
    })
    .sort((a, b) => a.personKeys[0].localeCompare(b.personKeys[0]))
}
