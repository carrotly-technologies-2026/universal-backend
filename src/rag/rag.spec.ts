import { chunkText } from './chunk.js';
import { dot, reciprocalRankFusion, topN } from './fusion.js';

describe('chunkText', () => {
  it('keeps short text in one chunk', () => {
    expect(chunkText('Akapit pierwszy.\n\nAkapit drugi.')).toEqual([
      'Akapit pierwszy.\n\nAkapit drugi.',
    ]);
  });

  it('cuts on paragraphs, respects the limit and overlaps', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Akapit ${i} ${'słowo '.repeat(30)}`.trim());
    const chunks = chunkText(paragraphs.join('\n\n'), { maxChars: 600, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(600);
    // The second chunk starts with the tail of the first.
    expect(chunks[0].endsWith(chunks[1].split('\n\n')[0])).toBe(true);
  });

  it('splits a paragraph longer than the limit', () => {
    const long = 'To jest zdanie testowe. '.repeat(100);
    const chunks = chunkText(long, { maxChars: 300, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
  });
});

describe('fusion', () => {
  it('counts only the best chunk of a document per ranking', () => {
    const scores = reciprocalRankFusion([['long', 'long', 'long', 'short']]);
    expect(scores.get('long')).toBeCloseTo(1 / 61);
    expect(scores.get('short')).toBeCloseTo(1 / 62);
  });

  it('ranks documents found by both rankings first', () => {
    const scores = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['c', 'd'],
    ]);
    const order = [...scores].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(order[0]).toBe('c');
    expect(order).toHaveLength(4);
  });

  it('dot and topN', () => {
    expect(dot([1, 0], [0.6, 0.8])).toBeCloseTo(0.6);
    expect(topN([0.1, 0.9, 0.5], 2)).toEqual([1, 2]);
  });
});

describe('embedding batches', () => {
  it('caps texts and estimated tokens per request', async () => {
    const { batches } = await import('../llm/gemini.service.js');
    const chunk = 'x'.repeat(3200); // ~800 tokens
    const out = batches(Array.from({ length: 25 }, () => chunk));
    expect(out.map((b) => b.length)).toEqual([10, 10, 5]);
    expect(batches(Array.from({ length: 150 }, () => 'krótki'))).toHaveLength(2);
    // A single oversized text still goes out alone.
    expect(batches(['y'.repeat(100_000)])).toHaveLength(1);
  });
});
