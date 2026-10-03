import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AnyBulkWriteOperation, ObjectId } from 'mongodb';
import { MongoService } from '../database/mongo.service.js';
import {
  embeddingDims,
  GeminiService,
  LlmUnavailableError,
} from '../llm/gemini.service.js';
import { chunkText } from './chunk.js';
import { dot, reciprocalRankFusion, topN } from './fusion.js';

export interface RagDocumentInput {
  url: string;
  title: string;
  text: string;
  /** Where the document comes from, e.g. "biblioteka"; filterable. */
  source: string;
  category?: string | null;
  /** Free-form labels; search can require any of them. */
  tags?: string[];
  /** Short human-readable summary returned with hits. */
  summary?: string | null;
  contact?: string | null;
  meta?: Record<string, unknown>;
}

export interface RagDocument extends Omit<RagDocumentInput, 'text'> {
  _id: ObjectId;
  corpus: string;
  tags: string[];
  hash: string;
  active: boolean;
  chunkCount: number;
  fetchedAt: Date;
  updatedAt: Date;
}

interface RagChunk {
  _id?: ObjectId;
  corpus: string;
  documentId: ObjectId;
  n: number;
  text: string;
  embedding: number[] | null;
  /** Separate flag so the index does not have to cover the vector array. */
  embedded: boolean;
  source: string;
  tags: string[];
  active: boolean;
}

interface RagCorpus {
  _id: string;
  version: number;
  embeddingModel?: string;
  embeddingDims?: number;
  updatedAt: Date;
}

export interface SearchOptions {
  k?: number;
  /** Only documents having at least one of these tags. */
  tags?: string[];
  sources?: string[];
  /** Only documents in one of these categories. */
  categories?: string[];
  /** Give up on the vector half after this long and use text search only. */
  embedTimeoutMs?: number;
}

export interface RagHit {
  documentId: string;
  url: string;
  title: string;
  source: string;
  category: string | null;
  tags: string[];
  summary: string | null;
  contact: string | null;
  meta: Record<string, unknown>;
  snippet: string;
  score: number;
}

export type UpsertResult = 'created' | 'updated' | 'unchanged';

interface VectorIndex {
  version: number;
  ids: ObjectId[];
  documentIds: string[];
  sources: string[];
  tags: string[][];
  vectors: Float32Array[];
}

// Chunks taken from each ranking before fusion (several may belong to one document).
const CANDIDATES = 80;

export const contentHash = (d: RagDocumentInput): string =>
  createHash('sha256')
    .update(
      JSON.stringify([d.title, d.text, d.category, d.tags, d.source, d.contact]),
    )
    .digest('hex');

/**
 * Generic retrieval-augmented-generation store. Any number of corpora live in
 * the same collections; documents are chunked, embedded with Gemini and
 * searched with vector + full-text ranking fused by RRF. Vector search runs in
 * process over an in-memory copy of the embeddings (fine up to ~100k chunks),
 * so plain MongoDB without Atlas Vector Search is enough.
 */
@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly vectorIndexes = new Map<string, Promise<VectorIndex>>();

  constructor(
    private readonly mongo: MongoService,
    private readonly gemini: GeminiService,
  ) {}

  /** The stored document if it already has this content (and is active). */
  async findUnchanged(
    corpus: string,
    input: RagDocumentInput,
  ): Promise<Pick<RagDocument, 'summary' | 'meta'> | null> {
    const docs = await this.documents();
    const doc = await docs.findOne(
      { corpus, url: input.url },
      { projection: { hash: 1, active: 1, summary: 1, meta: 1 } },
    );
    return doc?.hash === contentHash(input) && doc.active ? doc : null;
  }

  /**
   * Stores the document and its chunks (without embeddings; call
   * embedMissing afterwards). Unchanged content is left alone.
   */
  async upsertDocument(
    corpus: string,
    input: RagDocumentInput,
  ): Promise<UpsertResult> {
    const [docs, chunks] = await Promise.all([this.documents(), this.chunks()]);
    const hash = contentHash(input);
    const now = new Date();
    const existing = await docs.findOne({ corpus, url: input.url });
    if (existing?.hash === hash) {
      await docs.updateOne(
        { _id: existing._id },
        {
          $set: {
            fetchedAt: now,
            active: true,
            ...(input.summary && { summary: input.summary }),
            ...(input.meta && { meta: input.meta }),
          },
        },
      );
      if (!existing.active) {
        await chunks.updateMany(
          { documentId: existing._id },
          { $set: { active: true } },
        );
        await this.bumpVersion(corpus);
      }
      return 'unchanged';
    }

    const fields = {
      corpus,
      url: input.url,
      title: input.title,
      source: input.source,
      category: input.category ?? null,
      tags: input.tags ?? [],
      summary: input.summary ?? null,
      contact: input.contact ?? null,
      meta: input.meta ?? {},
      hash,
      active: true,
      fetchedAt: now,
      updatedAt: now,
    };
    const header = [input.title, input.category].filter(Boolean).join(' – ');
    const texts = chunkText(input.text).map((c) =>
      header ? `${header}\n\n${c}` : c,
    );
    const { value } = await docs.findOneAndUpdate(
      { corpus, url: input.url },
      { $set: { ...fields, chunkCount: texts.length } },
      { upsert: true, returnDocument: 'after', includeResultMetadata: true },
    );
    const documentId = value!._id;
    await chunks.deleteMany({ documentId });
    if (texts.length > 0) {
      await chunks.insertMany(
        texts.map((text, n) => ({
          corpus,
          documentId,
          n,
          text,
          embedding: null,
          embedded: false,
          source: fields.source,
          tags: fields.tags,
          active: true,
        })),
      );
    }
    await this.bumpVersion(corpus);
    return existing ? 'updated' : 'created';
  }

  /** Deactivates documents of a source that were not seen in the last crawl. */
  async deactivateMissing(
    corpus: string,
    source: string,
    seenUrls: string[],
  ): Promise<number> {
    const [docs, chunks] = await Promise.all([this.documents(), this.chunks()]);
    const gone = await docs
      .find(
        { corpus, source, active: true, url: { $nin: seenUrls } },
        { projection: { _id: 1 } },
      )
      .toArray();
    if (gone.length === 0) return 0;
    const ids = gone.map((d) => d._id);
    await docs.updateMany({ _id: { $in: ids } }, { $set: { active: false } });
    await chunks.updateMany(
      { documentId: { $in: ids } },
      { $set: { active: false } },
    );
    await this.bumpVersion(corpus);
    return ids.length;
  }

  /**
   * Embeds every chunk that has no embedding yet. Re-embeds the whole corpus
   * if the embedding model or dimension changed. Stops quietly (returning the
   * count so far) if the model becomes unavailable.
   */
  async embedMissing(corpus: string): Promise<number> {
    const [chunks, corpora] = await Promise.all([this.chunks(), this.corpora()]);
    const model = this.gemini.embeddingModel;
    const dims = embeddingDims();
    const meta = await corpora.findOne({ _id: corpus });
    if (meta && (meta.embeddingModel !== model || meta.embeddingDims !== dims)) {
      await chunks.updateMany(
        { corpus },
        { $set: { embedding: null, embedded: false } },
      );
    }
    await corpora.updateOne(
      { _id: corpus },
      {
        $set: { embeddingModel: model, embeddingDims: dims, updatedAt: new Date() },
        $setOnInsert: { version: 0 },
      },
      { upsert: true },
    );

    let done = 0;
    try {
      for (;;) {
        const batch = await chunks
          .find(
            { corpus, active: true, embedded: false },
            { projection: { text: 1 } },
          )
          .limit(100)
          .toArray();
        if (batch.length === 0) break;
        const vectors = await this.gemini.embed(
          batch.map((c) => c.text),
          'RETRIEVAL_DOCUMENT',
        );
        const ops: AnyBulkWriteOperation<RagChunk>[] = batch.map((c, i) => ({
          updateOne: {
            filter: { _id: c._id },
            update: { $set: { embedding: vectors[i], embedded: true } },
          },
        }));
        await chunks.bulkWrite(ops);
        done += batch.length;
      }
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) throw err;
      this.logger.warn(`Embedding stopped after ${done} chunks: ${err.message}`);
    }
    if (done > 0) await this.bumpVersion(corpus);
    return done;
  }

  async search(
    corpus: string,
    query: string,
    opts: SearchOptions = {},
  ): Promise<RagHit[]> {
    const k = opts.k ?? 3;
    const filter = {
      corpus,
      active: true,
      ...(opts.tags?.length && { tags: { $in: opts.tags } }),
      ...(opts.sources?.length && { source: { $in: opts.sources } }),
    };
    const [vectorRanking, textRanking] = await Promise.all([
      this.vectorRanking(corpus, query, opts),
      this.chunks().then((c) =>
        c
          .find(
            { ...filter, $text: { $search: query } },
            {
              projection: { documentId: 1, text: 1, score: { $meta: 'textScore' } },
            },
          )
          .sort({ score: { $meta: 'textScore' } })
          .limit(CANDIDATES)
          .toArray(),
      ),
    ]);

    const snippets = new Map<string, string>();
    const textIds = textRanking.map((c) => c.documentId.toHexString());
    // Best chunk per document, vector first: it is usually the better match.
    for (const c of [...vectorRanking.chunks, ...textRanking]) {
      const id = c.documentId.toHexString();
      if (!snippets.has(id)) snippets.set(id, c.text);
    }
    const scores = reciprocalRankFusion([vectorRanking.documentIds, textIds]);
    const ranked = [...scores].sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0) return [];

    const docs = await this.documents();
    const found = await docs
      .find({
        _id: { $in: ranked.slice(0, opts.categories?.length ? k * 8 : k * 3).map(([id]) => new ObjectId(id)) },
        active: true,
        ...(opts.categories?.length && { category: { $in: opts.categories } }),
      })
      .toArray();
    const byId = new Map(found.map((d) => [d._id.toHexString(), d]));
    return ranked
      .filter(([id]) => byId.has(id))
      .slice(0, k)
      .map(([id, score]) => {
        const d = byId.get(id)!;
        return {
          documentId: id,
          url: d.url,
          title: d.title,
          source: d.source,
          category: d.category ?? null,
          tags: d.tags,
          summary: d.summary ?? null,
          contact: d.contact ?? null,
          meta: d.meta ?? {},
          snippet: (snippets.get(id) ?? '').slice(0, 600),
          score,
        };
      });
  }

  async stats(corpus: string) {
    const [docs, chunks, corpora] = await Promise.all([
      this.documents(),
      this.chunks(),
      this.corpora(),
    ]);
    const [bySource, chunkCount, embedded, meta, last] = await Promise.all([
      docs
        .aggregate<{ _id: string; active: number; inactive: number }>([
          { $match: { corpus } },
          {
            $group: {
              _id: '$source',
              active: { $sum: { $cond: ['$active', 1, 0] } },
              inactive: { $sum: { $cond: ['$active', 0, 1] } },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
      chunks.countDocuments({ corpus, active: true }),
      chunks.countDocuments({ corpus, active: true, embedded: true }),
      corpora.findOne({ _id: corpus }),
      docs.find({ corpus }).sort({ fetchedAt: -1 }).limit(1).next(),
    ]);
    return {
      corpus,
      sources: bySource.map((s) => ({
        source: s._id,
        active: s.active,
        inactive: s.inactive,
      })),
      documents: bySource.reduce((n, s) => n + s.active, 0),
      chunks: chunkCount,
      embeddedChunks: embedded,
      embeddingModel: meta?.embeddingModel ?? null,
      embeddingDims: meta?.embeddingDims ?? null,
      lastFetchedAt: last?.fetchedAt ?? null,
    };
  }

  /** Document counts per source and per category (for search filters). */
  async facets(corpus: string) {
    const docs = await this.documents();
    const [sources, categories] = await Promise.all([
      docs.aggregate<{ _id: string; n: number }>([{ $match: { corpus, active: true } }, { $group: { _id: '$source', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
      docs.aggregate<{ _id: string | null; n: number }>([{ $match: { corpus, active: true } }, { $group: { _id: '$category', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
    ]);
    return {
      sources: sources.map((s) => ({ value: s._id, count: s.n })),
      categories: categories.filter((c) => c._id).map((c) => ({ value: c._id!, count: c.n })),
    };
  }

  /** Browse active documents without a query, newest first. */
  async browse(corpus: string, opts: { sources?: string[]; categories?: string[]; limit: number; offset: number }) {
    const docs = await this.documents();
    const filter = {
      corpus,
      active: true,
      ...(opts.sources?.length && { source: { $in: opts.sources } }),
      ...(opts.categories?.length && { category: { $in: opts.categories } }),
    };
    const [items, total] = await Promise.all([
      docs.find(filter, { projection: { hash: 0 } }).sort({ title: 1 }).skip(opts.offset).limit(opts.limit).toArray(),
      docs.countDocuments(filter),
    ]);
    return { items, total };
  }

  async listDocuments(corpus: string, source?: string, limit = 100) {
    const docs = await this.documents();
    return docs
      .find(
        { corpus, ...(source && { source }) },
        { projection: { corpus: 0, hash: 0 } },
      )
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
  }

  private async vectorRanking(
    corpus: string,
    query: string,
    opts: SearchOptions,
  ): Promise<{ documentIds: string[]; chunks: { documentId: ObjectId; text: string }[] }> {
    const none = { documentIds: [], chunks: [] };
    if (!this.gemini.available) return none;
    let q: number[];
    try {
      [q] = await withTimeout(
        this.gemini.embed([query], 'RETRIEVAL_QUERY', opts.embedTimeoutMs),
        opts.embedTimeoutMs ?? 10_000,
      );
    } catch (err) {
      this.logger.warn(`Query embedding failed, text search only: ${String(err)}`);
      return none;
    }
    const index = await this.vectorIndex(corpus);
    const allowed = (i: number) =>
      (!opts.sources?.length || opts.sources.includes(index.sources[i])) &&
      (!opts.tags?.length || index.tags[i].some((t) => opts.tags!.includes(t)));
    const scores = index.vectors.map((v, i) =>
      allowed(i) && v.length === q.length ? dot(q, v) : -Infinity,
    );
    const best = topN(scores, CANDIDATES).filter((i) => scores[i] > -Infinity);
    const chunks = await this.chunks();
    const texts = await chunks
      .find(
        { _id: { $in: best.map((i) => index.ids[i]) } },
        { projection: { documentId: 1, text: 1 } },
      )
      .toArray();
    const textById = new Map(texts.map((c) => [c._id.toHexString(), c]));
    return {
      documentIds: best.map((i) => index.documentIds[i]),
      chunks: best
        .map((i) => textById.get(index.ids[i].toHexString()))
        .filter((c) => c !== undefined),
    };
  }

  /** In-memory embeddings of a corpus, reloaded whenever its version moves. */
  private async vectorIndex(corpus: string): Promise<VectorIndex> {
    const corpora = await this.corpora();
    const version = (await corpora.findOne({ _id: corpus }))?.version ?? 0;
    const cached = this.vectorIndexes.get(corpus);
    if (cached && (await cached).version === version) return cached;
    const loading = this.loadVectorIndex(corpus, version);
    this.vectorIndexes.set(corpus, loading);
    loading.catch(() => this.vectorIndexes.delete(corpus));
    return loading;
  }

  private async loadVectorIndex(
    corpus: string,
    version: number,
  ): Promise<VectorIndex> {
    const chunks = await this.chunks();
    const index: VectorIndex = {
      version,
      ids: [],
      documentIds: [],
      sources: [],
      tags: [],
      vectors: [],
    };
    const cursor = chunks.find(
      { corpus, active: true, embedded: true },
      { projection: { documentId: 1, embedding: 1, source: 1, tags: 1 } },
    );
    for await (const c of cursor) {
      index.ids.push(c._id);
      index.documentIds.push(c.documentId.toHexString());
      index.sources.push(c.source);
      index.tags.push(c.tags);
      index.vectors.push(Float32Array.from(c.embedding!));
    }
    return index;
  }

  private async bumpVersion(corpus: string): Promise<void> {
    const corpora = await this.corpora();
    await corpora.updateOne(
      { _id: corpus },
      { $inc: { version: 1 }, $set: { updatedAt: new Date() } },
      { upsert: true },
    );
  }

  private documents() {
    return this.mongo.collection<RagDocument>('rag_documents', [
      { key: { corpus: 1, url: 1 }, unique: true },
      { key: { corpus: 1, source: 1, active: 1 } },
    ]);
  }

  private chunks() {
    return this.mongo.collection<RagChunk>('rag_chunks', [
      { key: { documentId: 1 } },
      { key: { corpus: 1, active: 1, embedded: 1 } },
      {
        key: { corpus: 1, text: 'text' },
        name: 'corpus_text',
        // No stemming: corpora are multilingual (mostly Polish, which MongoDB
        // has no stemmer for).
        default_language: 'none',
      },
    ]);
  }

  private corpora() {
    return this.mongo.collection<RagCorpus>('rag_corpora');
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
