import { embedTexts } from '../embeddings'
import type { AiConfig } from '../types'

// Grouping helpers for the learning jobs: OpenAI embeddings when the
// account has an OpenAI key, plain word overlap otherwise.

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9ñ]+/)
      .filter((w) => w.length > 2),
  )
}

export function jaccard(a: string, b: string): number {
  const wa = words(a)
  const wb = words(b)
  if (wa.size === 0 || wb.size === 0) return 0
  let inter = 0
  for (const w of wa) if (wb.has(w)) inter += 1
  return inter / (wa.size + wb.size - inter)
}

/** Pairwise similarity function over `texts` (indices). */
export type Similarity = (i: number, j: number) => number

/** Embedding similarity, or word overlap when there's no key / it fails. */
export async function similarityFor(
  config: Pick<AiConfig, 'provider' | 'apiKey' | 'embeddingsApiKey'>,
  texts: string[],
): Promise<{ sim: Similarity; semantic: boolean }> {
  const key = config.embeddingsApiKey ?? (config.provider === 'openai' ? config.apiKey : null)
  if (key && texts.length > 0) {
    try {
      const vectors = await embedTexts(key, texts.map((t) => t.slice(0, 1_000)))
      return { sim: (i, j) => cosine(vectors[i], vectors[j]), semantic: true }
    } catch (err) {
      console.error('[ai-learning] embeddings failed, using word overlap:', err instanceof Error ? err.message : err)
    }
  }
  return { sim: (i, j) => jaccard(texts[i], texts[j]), semantic: false }
}

/** Thresholds per similarity kind. */
export function groupThreshold(semantic: boolean): number {
  return semantic ? 0.82 : 0.45
}

/** Pure: greedy clustering — each item joins the first group whose
 *  seed is similar enough, else starts a new group. */
export function greedyGroups(n: number, sim: Similarity, threshold: number): number[][] {
  const groups: number[][] = []
  for (let i = 0; i < n; i++) {
    const g = groups.find((grp) => sim(grp[0], i) >= threshold)
    if (g) g.push(i)
    else groups.push([i])
  }
  return groups
}
