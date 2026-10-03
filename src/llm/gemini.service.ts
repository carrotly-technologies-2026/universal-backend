import { FinishReason, GoogleGenAI } from '@google/genai';
import { Injectable, Logger } from '@nestjs/common';

export class LlmUnavailableError extends Error {}

export type EmbeddingTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface GenerateOptions {
  system: string;
  prompt: string;
  /** JSON schema; the response is then parsed and returned as an object. */
  jsonSchema?: object;
  timeoutMs?: number;
}

// Aliases available on the Gemini free tier.
const TEXT_MODEL = () => process.env.LLM_MODEL || 'gemini-flash-latest';
const EMBEDDING_MODEL = () =>
  process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
export const embeddingDims = () =>
  Number(process.env.EMBEDDING_DIMS || 768);

// gemini-embedding-001 accepts up to 100 texts per request, but the free
// tier's per-minute token quota is smaller than 100 chunks; batches are also
// capped by estimated tokens so one request always fits the quota.
const EMBED_BATCH = 100;
const EMBED_BATCH_TOKENS = 8_000;
// Tried in order when the primary model is overloaded (503) or rate limited.
const FALLBACK_MODELS = ['gemini-flash-lite-latest'];

const tokens = (t: string) => Math.ceil(t.length / 4);

/**
 * Thin Gemini client shared by feature modules: text generation and
 * embeddings. Throws LlmUnavailableError when there is no key or the call fails,
 * so callers can degrade instead of returning 500.
 */
@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private client?: GoogleGenAI;
  // Free-tier embedding quota is per minute of tokens; spread batches out.
  private embedWindow: { start: number; tokens: number } = {
    start: 0,
    tokens: 0,
  };

  get available(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  get embeddingModel(): string {
    return EMBEDDING_MODEL();
  }

  async generate(opts: GenerateOptions & { jsonSchema: object }): Promise<unknown>;
  async generate(opts: GenerateOptions): Promise<string>;
  async generate(opts: GenerateOptions): Promise<unknown> {
    const models = [TEXT_MODEL(), ...FALLBACK_MODELS.filter((m) => m !== TEXT_MODEL())];
    for (let i = 0; ; i++) {
      try {
        // Two attempts per model, then the next model.
        return await this.generateWith(models[Math.floor(i / 2)], opts);
      } catch (err) {
        const last = Math.floor(i / 2) >= models.length - 1 && i % 2 === 1;
        if (!(err instanceof LlmUnavailableError) || !isTransient(err) || last) throw err;
        await sleep((i % 2 === 0 ? 5 : 15) * 1000);
      }
    }
  }

  private async generateWith(model: string, opts: GenerateOptions): Promise<unknown> {
    const ai = this.ai();
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
        config: {
          systemInstruction: opts.system,
          httpOptions: { timeout: opts.timeoutMs ?? 120_000 },
          ...(opts.jsonSchema && {
            responseMimeType: 'application/json',
            responseJsonSchema: opts.jsonSchema,
          }),
        },
      });
      const finish = response.candidates?.[0]?.finishReason;
      if (
        response.promptFeedback?.blockReason ||
        (finish && finish !== FinishReason.STOP) ||
        !response.text
      ) {
        throw new LlmUnavailableError(
          `No usable response (finish: ${finish ?? 'none'}).`,
        );
      }
      return opts.jsonSchema ? JSON.parse(response.text) : response.text;
    } catch (err) {
      if (err instanceof LlmUnavailableError) throw err;
      this.logger.warn(`Generation failed: ${String(err)}`);
      throw new LlmUnavailableError(String(err));
    }
  }

  /** Unit-length embeddings (truncated Gemini vectors are not normalized). */
  async embed(
    texts: string[],
    task: EmbeddingTask,
    timeoutMs = 60_000,
  ): Promise<number[][]> {
    const ai = this.ai();
    const out: number[][] = [];
    for (const batch of batches(texts)) {
      if (task === 'RETRIEVAL_DOCUMENT') await this.throttle(batch);
      const response = await this.withRetry(() =>
        ai.models.embedContent({
          model: EMBEDDING_MODEL(),
          contents: batch,
          config: {
            taskType: task,
            outputDimensionality: embeddingDims(),
            httpOptions: { timeout: timeoutMs },
          },
        }),
      );
      const vectors = response.embeddings?.map((e) => e.values ?? []) ?? [];
      if (vectors.length !== batch.length) {
        throw new LlmUnavailableError('Embedding count mismatch.');
      }
      out.push(...vectors.map(normalize));
    }
    return out;
  }

  private ai(): GoogleGenAI {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new LlmUnavailableError('GEMINI_API_KEY is not set.');
    this.client ??= new GoogleGenAI({ apiKey });
    return this.client;
  }

  private async throttle(batch: string[]): Promise<void> {
    const limit = Number(process.env.EMBEDDING_TOKENS_PER_MINUTE || 25_000);
    const needed = batch.reduce((n, t) => n + tokens(t), 0);
    const now = Date.now();
    if (now - this.embedWindow.start >= 60_000) {
      this.embedWindow = { start: now, tokens: 0 };
    }
    if (this.embedWindow.tokens > 0 && this.embedWindow.tokens + needed > limit) {
      await sleep(60_000 - (now - this.embedWindow.start));
      this.embedWindow = { start: Date.now(), tokens: 0 };
    }
    this.embedWindow.tokens += needed;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isTransient(err) || attempt >= 5) {
          this.logger.warn(`Embedding failed: ${String(err)}`);
          throw new LlmUnavailableError(String(err));
        }
        // Per-minute quotas: wait for the window to roll over.
        await sleep(Math.min(2 ** attempt * 10_000, 65_000));
        this.embedWindow = { start: Date.now(), tokens: 0 };
      }
    }
  }
}

function isTransient(err: unknown): boolean {
  return /429|RESOURCE_EXHAUSTED|503|UNAVAILABLE|overloaded|high demand/i.test(String(err));
}

/** Splits texts into requests of at most EMBED_BATCH texts and EMBED_BATCH_TOKENS tokens. */
export function batches(texts: string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const t of texts) {
    if (current.length && (current.length >= EMBED_BATCH || size + tokens(t) > EMBED_BATCH_TOKENS)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(t);
    size += tokens(t);
  }
  if (current.length) out.push(current);
  return out;
}

function normalize(v: number[]): number[] {
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
