import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { join } from 'node:path';
import { GeminiService, sleep } from '../../llm/gemini.service.js';
import { RagDocumentInput, RagService } from '../../rag/rag.service.js';
import { HalohubStore } from '../halohub.store.js';
import { CORPUS, IngestRun } from '../model.js';
import { PoliteFetcher, pdfText } from './fetcher.js';
import {
  documentLinks,
  entryLinks,
  extractiveSummary,
  pageLinks,
  parseEntry,
} from './parse.js';
import {
  BIBLIOTEKA,
  KATEGORIE_BIBLIOTEKI,
  MAPA_WYZWAN,
  NAZWY_KATEGORII,
  PUBLIKACJE,
  RAPORTY,
  ZRODLA,
  Zrodlo,
} from './sources.js';

export interface IngestOptions {
  zrodla?: string[];
  /** Max documents per source (for quick tests). Disables deactivation. */
  limit?: number;
}

const env = (name: string, fallback: number) => Number(process.env[name] || fallback);

const SUMMARY_SYSTEM = `Piszesz streszczenia do przeczytania przez telefon seniorom i osobom z niepełnosprawnościami.
Napisz dokładnie 2 proste, krótkie zdania po polsku: czym jest rozwiązanie i komu i jak pomaga.
Bez wstępów, bez list, bez nawiasów. Tylko fakty z tekstu.`;

/**
 * hubMI / ROPS ingest (PLAN.md 6.2): crawl → parse → voice summary →
 * chunk + embed in the generic RAG store → deactivate what disappeared.
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);
  private running: Promise<unknown> | null = null;

  constructor(
    private readonly rag: RagService,
    private readonly gemini: GeminiService,
    private readonly store: HalohubStore,
  ) {}

  get busy(): boolean {
    return this.running !== null;
  }

  /** Starts a run in the background; returns its id at once. */
  async start(opts: IngestOptions = {}): Promise<{ id: string; status: 'trwa' }> {
    if (this.running) throw new ConflictException('Ingest is already running.');
    // Claimed before the first await so two callers cannot both start.
    let started!: (id: ObjectId) => void;
    const id = new Promise<ObjectId>((resolve) => (started = resolve));
    this.running = (async () => {
      const runs = await this.store.ingest();
      const { insertedId } = await runs.insertOne({
        start: new Date(),
        koniec: null,
        status: 'trwa',
        statystyki: {},
        bledy: [],
      } as unknown as IngestRun);
      started(insertedId);
      await this.execute(insertedId, opts);
    })().finally(() => {
      this.running = null;
    });
    // If the run record cannot be written, surface that error to the caller.
    const insertedId = await Promise.race([id, this.running.then(() => id)]);
    return { id: insertedId.toHexString(), status: 'trwa' };
  }

  /** Runs to completion (CLI). */
  async run(opts: IngestOptions = {}) {
    const { id } = await this.start(opts);
    await this.running;
    return (await this.store.ingest()).findOne({ _id: new ObjectId(id) });
  }

  private async execute(id: ObjectId, opts: IngestOptions): Promise<void> {
    const stats: Record<string, number> = {};
    const errors: string[] = [];
    const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
    const fetcher = new PoliteFetcher(
      join(process.env.DATA_DIR ?? './data', 'ingest-cache'),
    );
    const wanted = (opts.zrodla?.length ? opts.zrodla : ZRODLA).filter(
      (z): z is Zrodlo => (ZRODLA as readonly string[]).includes(z),
    );

    let failed = false;
    try {
      for (const zrodlo of wanted) {
        const seen: string[] = [];
        let complete = true;
        const save = async (doc: RagDocumentInput) => {
          seen.push(doc.url);
          bump(`${zrodlo}_${await this.rag.upsertDocument(CORPUS, await this.withSummary(doc))}`);
        };
        // `partial` problems (a scanned or missing attachment) are logged but
        // do not make the crawl incomplete.
        const fail = (url: string, err: unknown, partial = false) => {
          if (!partial) complete = false;
          errors.push(`${url}: ${String(err)}`.slice(0, 300));
          this.logger.warn(`Ingest ${url}: ${String(err)}`);
        };
        try {
          const docs = this.crawl(zrodlo, fetcher, opts.limit, fail);
          for await (const doc of docs) await save(doc);
        } catch (err) {
          fail(zrodlo, err);
        }
        // Only a complete, unlimited crawl may decide that a document is gone.
        if (complete && !opts.limit) {
          stats[`${zrodlo}_deactivated`] = await this.rag.deactivateMissing(CORPUS, zrodlo, seen);
        }
      }
      stats.embedded_chunks = await this.rag.embedMissing(CORPUS);
    } catch (err) {
      failed = true;
      errors.push(String(err));
      this.logger.error(`Ingest failed: ${String(err)}`);
    }
    await (await this.store.ingest()).updateOne(
      { _id: id },
      {
        $set: {
          koniec: new Date(),
          status: failed ? 'blad' : 'ok',
          statystyki: stats,
          bledy: errors.slice(0, 50),
        },
      },
    );
    this.logger.log(`Ingest finished: ${JSON.stringify(stats)}`);
  }

  private async *crawl(
    zrodlo: Zrodlo,
    f: PoliteFetcher,
    limit: number | undefined,
    fail: (url: string, err: unknown, partial?: boolean) => void,
  ): AsyncGenerator<RagDocumentInput> {
    const maxPdf = env('HALOHUB_INGEST_MAX_PDF_CHARS', 60_000);
    const pdfDoc = async (url: string, title: string, extra: Partial<RagDocumentInput> = {}) => {
      const { body, pdf } = await f.get(url);
      if (!pdf) throw new Error('not a PDF');
      const text = await pdfText(body, maxPdf);
      // Scans without a text layer are skipped in the MVP.
      if (text.length < 300) throw new Error('PDF has no text layer');
      return { url, title, text, source: zrodlo, tags: [], ...extra } as RagDocumentInput;
    };

    if (zrodlo === 'biblioteka') {
      let n = 0;
      for (const [category, grupy] of Object.entries(KATEGORIE_BIBLIOTEKI)) {
        const listUrl = `${BIBLIOTEKA}/${category}`;
        const entries = new Set<string>();
        const pages = [listUrl];
        for (let i = 0; i < pages.length && i < 20; i++) {
          const html = (await f.get(pages[i])).body.toString('utf8');
          entryLinks(html, pages[i], category).forEach((e) => entries.add(e));
          for (const p of pageLinks(html, pages[i])) if (!pages.includes(p)) pages.push(p);
        }
        for (const url of entries) {
          if (limit && n >= limit) return;
          try {
            const entry = parseEntry((await f.get(url)).body.toString('utf8'), url);
            if (!entry) throw new Error('no entry content');
            let text = entry.text;
            // The innovation model PDFs belong to the entry: one document each.
            for (const pdfUrl of entry.pdfs.slice(0, 3)) {
              try {
                text += `\n\n${(await pdfDoc(pdfUrl, entry.title)).text}`;
              } catch (err) {
                fail(pdfUrl, err, true);
              }
            }
            n++;
            yield {
              url,
              title: entry.title,
              text: text.slice(0, maxPdf + entry.text.length),
              source: zrodlo,
              category: NAZWY_KATEGORII[category] ?? category,
              tags: grupy,
              contact: entry.contact,
              meta: { kategoria_slug: category, pdfs: entry.pdfs },
            };
          } catch (err) {
            fail(url, err);
          }
        }
      }
      return;
    }

    if (zrodlo === 'mapa_wyzwan') {
      yield await pdfDoc(MAPA_WYZWAN, 'Mapa Wyzwań Społecznych Małopolski');
      return;
    }

    const listUrl = zrodlo === 'raporty' ? RAPORTY : PUBLIKACJE;
    const max = limit ?? env(zrodlo === 'raporty' ? 'HALOHUB_INGEST_MAX_RAPORTY' : 'HALOHUB_INGEST_MAX_PUBLIKACJE', 8);
    const links = documentLinks((await f.get(listUrl)).body.toString('utf8'), listUrl);
    const titles = new Map<string, string>();
    for (const l of links) if (l.text && !titles.has(l.url)) titles.set(l.url, l.text);
    let n = 0;
    for (const url of new Set(links.map((l) => l.url))) {
      if (n >= max) return;
      try {
        const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? url);
        yield await pdfDoc(url, titles.get(url) || name.replace(/[_-]+/g, ' ').replace(/\.pdf$/i, ''));
        n++;
      } catch (err) {
        fail(url, err, true);
      }
    }
  }

  /** LLM voice summary for changed library entries; extractive otherwise. */
  private async withSummary(doc: RagDocumentInput): Promise<RagDocumentInput> {
    const llmWanted = doc.source === 'biblioteka' && this.gemini.available;
    const stored = await this.rag.findUnchanged(CORPUS, doc);
    // Unchanged content keeps its summary, unless it is an extractive one
    // that an LLM can now improve (e.g. the API key was added later).
    if (stored && (!llmWanted || stored.meta?.streszczenie === 'llm')) {
      return { ...doc, summary: stored.summary, meta: { ...doc.meta, ...stored.meta } };
    }
    let summary = extractiveSummary(doc.text);
    let source = 'ekstrakt';
    if (llmWanted) {
      try {
        summary = (
          await this.gemini.generate({
            system: SUMMARY_SYSTEM,
            prompt: `${doc.title}\n\n${doc.text.slice(0, 6000)}`,
            timeoutMs: 60_000,
          })
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 450);
        source = 'llm';
        // Free tier allows ~10 generations per minute.
        await sleep(env('HALOHUB_INGEST_LLM_DELAY_MS', 6500));
      } catch (err) {
        this.logger.warn(`Summary failed for ${doc.url}: ${String(err)}`);
      }
    }
    return { ...doc, summary, meta: { ...doc.meta, streszczenie: source } };
  }
}
