export interface ChunkOptions {
  /** ~800 tokens of Polish text. */
  maxChars?: number;
  /** ~100 tokens carried over from the previous chunk. */
  overlapChars?: number;
}

/**
 * Splits text on paragraph boundaries (blank lines, which also separate
 * headings) into chunks of at most maxChars. Paragraphs longer than that are
 * split on sentences, then hard-cut. Each chunk after the first starts with
 * the tail of the previous one so facts on a boundary stay retrievable.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = opts.maxChars ?? 3200;
  const overlap = Math.min(opts.overlapChars ?? 400, Math.floor(maxChars / 4));
  const pieces = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .flatMap((p) => (p.length > maxChars ? splitLong(p, maxChars) : [p]));

  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > maxChars) {
      chunks.push(current);
      current = tail(current, overlap);
      // The carried-over tail must not push the next piece over the limit.
      if (current.length + piece.length + 2 > maxChars) current = '';
    }
    current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLong(paragraph: string, maxChars: number): string[] {
  const sentences = paragraph.match(/[^.!?]+[.!?]+["»”)]*\s*|[^.!?]+$/g) ?? [
    paragraph,
  ];
  const out: string[] = [];
  let current = '';
  for (const raw of sentences) {
    for (let s = raw; s.length > 0; s = s.slice(maxChars)) {
      const part = s.slice(0, maxChars);
      if (current && current.length + part.length > maxChars) {
        out.push(current.trim());
        current = '';
      }
      current += part;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** The last ~n characters, starting at a word boundary. */
function tail(text: string, n: number): string {
  if (n <= 0 || text.length <= n) return n <= 0 ? '' : text;
  const cut = text.slice(-n);
  const space = cut.indexOf(' ');
  return (space >= 0 ? cut.slice(space + 1) : cut).trim();
}
