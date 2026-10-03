import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  PipeTransform,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { requireSecret } from '../common/secret.js';
import { RagDocumentInput, RagService } from './rag.service.js';

class CorpusPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!/^[a-z0-9_-]{1,40}$/.test(value)) {
      throw new BadRequestException('corpus must match [a-z0-9_-]{1,40}.');
    }
    return value;
  }
}

const KEY = { header: 'x-api-key', env: 'RAG_API_KEY' };

/**
 * Generic RAG API for any client of this backend. Domain modules use
 * RagService directly; this is for pushing documents from scripts and for
 * searching from other apps. All endpoints need the x-api-key header.
 */
@Controller('rag/:corpus')
export class RagController {
  constructor(private readonly rag: RagService) {}

  @Get()
  stats(@Req() req: Request, @Param('corpus', CorpusPipe) corpus: string) {
    requireSecret(req, KEY);
    return this.rag.stats(corpus);
  }

  @Get('documents')
  list(
    @Req() req: Request,
    @Param('corpus', CorpusPipe) corpus: string,
    @Query('source') source?: string,
  ) {
    requireSecret(req, KEY);
    return this.rag.listDocuments(corpus, source);
  }

  @Post('search')
  @HttpCode(200)
  search(
    @Req() req: Request,
    @Param('corpus', CorpusPipe) corpus: string,
    @Body() body: unknown,
  ) {
    requireSecret(req, KEY);
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.query !== 'string' || !b.query.trim()) {
      throw new BadRequestException('query must be a non-empty string.');
    }
    return this.rag.search(corpus, b.query.trim().slice(0, 1000), {
      k: Math.min(Math.max(Number(b.k) || 5, 1), 20),
      tags: stringArray(b.tags),
      sources: stringArray(b.sources),
    });
  }

  /** Upserts documents (by url) and embeds the new chunks. */
  @Post('documents')
  async upsert(
    @Req() req: Request,
    @Param('corpus', CorpusPipe) corpus: string,
    @Body() body: unknown,
  ) {
    requireSecret(req, KEY);
    const docs = (body as { documents?: unknown })?.documents;
    if (!Array.isArray(docs) || docs.length === 0 || docs.length > 200) {
      throw new BadRequestException('documents must be an array of 1–200 items.');
    }
    const inputs = docs.map(parseDocument);
    const results = { created: 0, updated: 0, unchanged: 0 };
    for (const d of inputs) results[await this.rag.upsertDocument(corpus, d)]++;
    const embedded = await this.rag.embedMissing(corpus);
    return { ...results, embeddedChunks: embedded };
  }
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : undefined;
}

function parseDocument(raw: unknown, i: number): RagDocumentInput {
  const d = (raw ?? {}) as Record<string, unknown>;
  const str = (name: string, required: boolean) => {
    const v = d[name];
    if (v === undefined || v === null) {
      if (required) throw new BadRequestException(`documents[${i}].${name} is required.`);
      return null;
    }
    if (typeof v !== 'string') {
      throw new BadRequestException(`documents[${i}].${name} must be a string.`);
    }
    return v;
  };
  return {
    url: str('url', true)!,
    title: str('title', true)!,
    text: str('text', true)!,
    source: str('source', false) ?? 'api',
    category: str('category', false),
    summary: str('summary', false),
    contact: str('contact', false),
    tags: stringArray(d.tags) ?? [],
  };
}
