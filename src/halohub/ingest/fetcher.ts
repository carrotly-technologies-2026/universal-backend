import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractText, getDocumentProxy } from 'unpdf';
import { sleep } from '../../llm/gemini.service.js';
import { USER_AGENT } from './sources.js';

export interface Fetched {
  body: Buffer;
  pdf: boolean;
}

/**
 * Polite crawler: one request per second, robots.txt respected, raw
 * responses cached on disk so a re-run does not download everything again
 * (cache entries older than maxAgeMs are refetched).
 */
export class PoliteFetcher {
  private last = 0;
  private readonly robots = new Map<string, Promise<string[]>>();

  constructor(
    private readonly cacheDir: string,
    private readonly maxAgeMs = 6 * 86_400_000,
    private readonly delayMs = 1000,
  ) {}

  async get(url: string): Promise<Fetched> {
    const key = createHash('sha1').update(url).digest('hex');
    const file = join(this.cacheDir, key);
    try {
      const meta = JSON.parse(await readFile(`${file}.json`, 'utf8')) as {
        at: number;
        pdf: boolean;
      };
      if (Date.now() - meta.at < this.maxAgeMs) {
        return { body: await readFile(file), pdf: meta.pdf };
      }
    } catch {
      // Not cached yet.
    }

    if (!(await this.allowed(url))) throw new Error(`robots.txt disallows ${url}`);
    await this.wait();
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const body = Buffer.from(await res.arrayBuffer());
    const pdf = body.subarray(0, 5).toString('latin1') === '%PDF-';
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(file, body);
    await writeFile(`${file}.json`, JSON.stringify({ url, at: Date.now(), pdf }));
    return { body, pdf };
  }

  private async wait(): Promise<void> {
    const delay = this.last + this.delayMs - Date.now();
    if (delay > 0) await sleep(delay);
    this.last = Date.now();
  }

  private async allowed(url: string): Promise<boolean> {
    const { origin, pathname } = new URL(url);
    if (!this.robots.has(origin)) this.robots.set(origin, this.loadRobots(origin));
    const disallowed = await this.robots.get(origin)!;
    return !disallowed.some((p) => p && pathname.startsWith(p));
  }

  /** Disallow rules of the `User-agent: *` group (rops.krakow.pl has none). */
  private async loadRobots(origin: string): Promise<string[]> {
    try {
      await this.wait();
      const res = await fetch(`${origin}/robots.txt`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return [];
      return parseRobots(await res.text());
    } catch {
      return [];
    }
  }
}

export function parseRobots(txt: string): string[] {
  const rules: string[] = [];
  let applies = false;
  for (const raw of txt.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const [field, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (/^user-agent$/i.test(field)) applies = value === '*' || /HaloHubBot/i.test(value);
    else if (applies && /^disallow$/i.test(field)) rules.push(value);
  }
  return rules;
}

/** Text layer of a PDF; scans without one return ''. */
export async function pdfText(body: Buffer, maxChars: number): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(body));
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    let out = '';
    for (const page of text) {
      if (out.length >= maxChars) break;
      // Blank line between pages so chunking can cut there.
      out += `${page.replace(/[ \t]+/g, ' ').trim()}\n\n`;
    }
    return out.slice(0, maxChars).trim();
  } finally {
    await pdf.loadingTask.destroy();
  }
}
