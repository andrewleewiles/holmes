import type { MemoryField, Message } from '../shared/types'
import { MEMORY_CATALOG } from '../shared/memoryCatalog'
import {
  buildLocalRecallExpansions,
  buildRecallCandidateTerms,
  createRecallSnippet,
  scoreRecallText,
} from './recall'

export interface MemoryRecallQuery {
  category: string
  query: string
  expandedQueries: string[]
  terms: string[]
  filesystemTerms: string[]
}

export interface MemoryRecallDocument {
  reference: string
  label: string
  content: string
  capturedAt: number
  role?: Message['role']
}

export interface MemoryRecallMatch extends MemoryRecallDocument {
  category: string
  score: number
}

const CATEGORY_RECALL_TERMS: Record<string, string> = {
  identity: 'name call born birthday language speak timezone',
  contact: 'email phone address contact reach',
  household: 'live living partner spouse husband wife child home rent own',
  relationships: 'family friend colleague coworker communication social',
  health: 'allergy medication diagnosis condition doctor therapy fitness sleep',
  work: 'job work employer company title career schedule skill resume',
  education: 'school college university degree studied course certification learn',
  finances: 'money income salary budget savings debt bill subscription bank invest',
  pets: 'pet dog cat animal vet feed',
  preferences: 'favorite like love prefer dislike hobby style',
  routines: 'usually daily weekly morning evening wake bedtime routine commute',
  goals: 'goal want plan hope achieve deadline obstacle',
  travel: 'travel trip flight hotel airport vacation destination seat',
  technology: 'device computer phone software app service provider model technical',
  vehicles: 'car truck motorcycle vehicle insurance maintenance parking',
  possessions: 'property own bought purchase warranty storage inventory',
  'important-dates': 'birthday anniversary renewal appointment deadline date',
  browser_history: 'website browse visit search url page site domain internet',
  youtube_watches: 'youtube video watch channel stream subscribe playlist',
  amazon_orders: 'amazon order purchase buy delivery ship cart subscribe',
  email_threads: 'email mail thread reply correspond inbox send receive',
  app_usage: 'app application usage screen time launch open macos ios',
  photo_memories: 'photo picture image trip location face people place',
  location_history: 'location place visited travel trip home work commute',
  weather_patterns: 'weather climate temperature rain sun snow mood season',
  subscriptions: 'subscription recurring monthly yearly plan provider charge',
}

export function buildMemoryRecallQueries(fields: MemoryField[]): MemoryRecallQuery[] {
  const fieldsByCategory = new Map<string, MemoryField[]>()
  for (const field of fields) {
    const categoryFields = fieldsByCategory.get(field.category) || []
    categoryFields.push(field)
    fieldsByCategory.set(field.category, categoryFields)
  }

  const queriesByCategory = MEMORY_CATALOG.map((category) => {
    const categoryFields = fieldsByCategory.get(category.key)
      ?.sort((left, right) => Number(left.value !== null) - Number(right.value !== null))
    if (!categoryFields?.length) return [] as MemoryRecallQuery[]
    const chunks: MemoryField[][] = []
    for (const field of categoryFields) {
      const current = chunks.at(-1)
      const candidateLabels = [...(current || []), field].map((item) => item.label)
      const candidateQuery = `${category.label}: ${CATEGORY_RECALL_TERMS[category.key] || ''}; ${candidateLabels.join(', ')}`
      if (current && (current.length >= 4 || candidateQuery.length > 300)) chunks.push([field])
      else if (current) current.push(field)
      else chunks.push([field])
    }
    return chunks.map((chunk) => {
      const fieldLabels = chunk.map((field) => field.label)
      const fieldQuery = `${category.label}: ${fieldLabels.join(', ')}`
      const query = `${category.label}: ${CATEGORY_RECALL_TERMS[category.key] || ''}; ${fieldLabels.join(', ')}`
      const expandedQueries = buildLocalRecallExpansions(fieldQuery)
      const fieldPhrases = chunk.map((field) => field.label.normalize('NFKC').toLocaleLowerCase())
      return {
        category: category.key,
        query,
        expandedQueries,
        terms: [...new Set([...fieldPhrases, ...buildRecallCandidateTerms(query, expandedQueries)])].slice(0, 24),
        filesystemTerms: [...new Set([...fieldPhrases, ...expandedQueries])].slice(0, 12),
      }
    })
  })

  const interleaved: MemoryRecallQuery[] = []
  const maxChunks = Math.max(0, ...queriesByCategory.map((queries) => queries.length))
  for (let chunkIndex = 0; chunkIndex < maxChunks; chunkIndex += 1) {
    for (const queries of queriesByCategory) {
      if (queries[chunkIndex]) interleaved.push(queries[chunkIndex])
    }
  }
  return interleaved
}

export function rankMemoryRecallDocuments(
  documents: MemoryRecallDocument[],
  query: MemoryRecallQuery,
  maxResults: number,
  maxSnippetLength: number
): MemoryRecallMatch[] {
  return documents
    .filter((document) => document.role === undefined || document.role === 'user')
    .map((document) => ({
      ...document,
      category: query.category,
      score: scoreRecallText(document.content, document.label, query.query, query.expandedQueries),
      content: createRecallSnippet(document.content, query.terms, maxSnippetLength),
    }))
    .filter((document) => document.score > 0 && document.content.length > 0)
    .sort((left, right) => right.score - left.score || right.capturedAt - left.capturedAt)
    .slice(0, Math.max(0, maxResults))
}
