/** Dot product; equals cosine similarity for unit-length vectors. */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Reciprocal Rank Fusion. Each ranking lists chunk owners (document ids)
 * best-first; a document gains 1 / (k + rank) for every position it holds in
 * every ranking, so documents with several matching chunks rank higher.
 */
export function reciprocalRankFusion(
  rankings: string[][],
  k = 60,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return scores;
}

/** Indexes of the n highest scores, best first. */
export function topN(scores: ArrayLike<number>, n: number): number[] {
  const idx = Array.from({ length: scores.length }, (_, i) => i);
  return idx.sort((a, b) => scores[b] - scores[a]).slice(0, n);
}
