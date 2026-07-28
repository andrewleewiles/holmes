import type { ModelInfo, ProviderConfig } from '../shared/types'
import { listModels } from './provider'

export interface ModelPrice {
  promptPrice: number
  completionPrice: number
  imagePrice: number
  acceptsImages: boolean
  /**
   * Context window in tokens, when the provider reports one. The activity
   * analysis sizes its chunks from this so a Frontier run reads far more per
   * call than a Budget one, instead of every tier sharing one fixed cap.
   */
  contextLength: number | null
}

export type PriceTable = Map<string, ModelPrice>

const CACHE_TTL_MS = 10 * 60 * 1000

let cache: { table: PriceTable; fetchedAt: number } | null = null

export function buildPriceTable(models: ModelInfo[]): PriceTable {
  const table: PriceTable = new Map()
  for (const model of models) {
    // A model with no prompt price is unpriced, not free. Leaving it out of the
    // table entirely is what makes the estimator report "cost unknown" rather
    // than quoting $0 for a custom endpoint that reports no pricing.
    if (model.promptPrice === undefined && model.completionPrice === undefined) continue
    table.set(model.id, {
      promptPrice: model.promptPrice ?? 0,
      completionPrice: model.completionPrice ?? 0,
      imagePrice: model.imagePrice ?? 0,
      acceptsImages: Array.isArray(model.inputModalities) && model.inputModalities.includes('image'),
      contextLength: model.contextLength ?? null,
    })
  }
  return table
}

// Cached because an index run prices thousands of calls and the estimator reruns
// on every UI interaction. Failure yields an empty table, which downstream
// reports as unknown cost rather than as free.
export async function getPriceTable(config: ProviderConfig, force = false): Promise<PriceTable> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.table
  try {
    const models = await listModels(config)
    const table = buildPriceTable(models)
    if (table.size > 0) cache = { table, fetchedAt: Date.now() }
    return table
  } catch {
    return cache?.table ?? new Map()
  }
}

export function resetPriceTableCache(): void {
  cache = null
}

/**
 * The cached table without the network fallback. The call logger prices rows
 * from this: fetching the model list there would log that fetch, which would
 * price it, which would fetch the model list. A miss simply leaves the row
 * unpriced until the Call History page backfills it.
 */
export function peekPriceTable(): PriceTable {
  return cache?.table ?? new Map()
}

export function priceCall(
  table: PriceTable,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  imageCount = 0
): number | null {
  const price = table.get(modelId)
  if (!price) return null
  return (
    inputTokens * price.promptPrice +
    outputTokens * price.completionPrice +
    imageCount * price.imagePrice
  )
}

export function formatUsd(value: number): string {
  if (value === 0) return '$0.00'
  if (value < 0.01) return `<$0.01`
  if (value < 1) return `$${value.toFixed(2)}`
  if (value < 100) return `$${value.toFixed(2)}`
  return `$${Math.round(value).toLocaleString()}`
}
