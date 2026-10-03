/** Dot product; equals cosine similarity for unit-length vectors. */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Reciprocal Rank Fusion over document rankings. Each ranking lists chunk
 * owners (document ids) best-first; only a document's best position in each
 * ranking counts. Summing every chunk would let long documents (a library
 * entry with an attached 60-page PDF) win every query.
 */
export function reciprocalRankFusion(
  rankings: string[][],
  k = 60,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    let rank = 0;
    for (const id of ranking) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank++;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    }
  }
  return scores;
}

/** Indexes of the n highest scores, best first. */
export function topN(scores: ArrayLike<number>, n: number): number[] {
  const idx = Array.from({ length: scores.length }, (_, i) => i);
  return idx.sort((a, b) => scores[b] - scores[a]).slice(0, n);
}
