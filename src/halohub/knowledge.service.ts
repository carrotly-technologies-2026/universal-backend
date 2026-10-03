import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RagHit, RagService } from '../rag/rag.service.js';
import { HalohubStore } from './halohub.store.js';
import { CORPUS, Innowacja } from './model.js';

export interface WynikWiedzy {
  tytul: string;
  glos_streszczenie: string | null;
  kontakt: string | null;
  url: string;
  zrodlo: string;
}

export interface OdpowiedzWiedzy {
  wyniki: WynikWiedzy[];
  komunikat: string | null;
}

export interface PytanieWiedzy {
  pytanie: string;
  grupa?: string | null;
  jezyk?: string | null;
  conversation_id?: string | null;
}

const ZRODLA_NAZWY: Record<string, string> = {
  biblioteka: 'Biblioteka Innowacji Społecznych ROPS w Krakowie',
  raporty: 'Baza Raportów ROPS w Krakowie',
  mapa_wyzwan: 'Mapa Wyzwań Społecznych ROPS',
  publikacje: 'Publikacje ze świata innowacji ROPS',
};

const BRAK = 'Brak wyników. Podaj kontakt do Działu Innowacji Społecznych ROPS: 12 422 06 36.';
// Voice agents pay latency per token; keep each result short.
const MAX_STRESZCZENIE = 450;

/** The `szukaj_wiedzy` tool (PLAN.md 8.5) on top of the generic RAG store. */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly rag: RagService,
    private readonly store: HalohubStore,
  ) {}

  /** Never throws: a broken search answers "no results" to the caller. */
  async szukaj(q: PytanieWiedzy, demo = false): Promise<OdpowiedzWiedzy> {
    const pytanie = q.pytanie.trim().slice(0, 500);
    const grupa = q.grupa?.trim() || null;
    let wyniki: WynikWiedzy[];
    try {
      wyniki = await this.cached(pytanie, grupa);
    } catch (err) {
      this.logger.warn(`szukaj_wiedzy failed: ${String(err)}`);
      return { wyniki: [], komunikat: 'Wyszukiwarka nie odpowiada. ' + BRAK };
    }
    try {
      await (await this.store.zapytania()).insertOne({
        conversation_id: q.conversation_id ?? null,
        pytanie,
        grupa,
        jezyk: q.jezyk ?? null,
        liczba_wynikow: wyniki.length,
        top_url: wyniki[0]?.url ?? null,
        top_tytul: wyniki[0]?.tytul ?? null,
        demo,
        utworzono: new Date(),
      } as never);
    } catch (err) {
      this.logger.warn(`Query log failed: ${String(err)}`);
    }
    return { wyniki, komunikat: wyniki.length ? null : BRAK };
  }

  /** Innovations matching a topic, for reports and the priority list. */
  async innowacje(tekst: string, k = 3): Promise<Innowacja[]> {
    const hits = await this.rag.search(CORPUS, tekst, {
      k,
      sources: ['biblioteka'],
    });
    return hits.map(toWynik);
  }

  private async cached(pytanie: string, grupa: string | null) {
    const id = `rag:${createHash('sha1').update(`${pytanie.toLowerCase()}|${grupa ?? ''}`).digest('hex')}`;
    const cache = await this.store.cache();
    const hit = await cache.findOne({ _id: id, wygasa: { $gt: new Date() } });
    if (hit) return hit.wartosc as WynikWiedzy[];

    const sources = (process.env.HALOHUB_TOOL_SOURCES || 'biblioteka')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const hits = await this.rag.search(CORPUS, pytanie, {
      k: Number(process.env.RAG_TOP_K || 3),
      // Documents tagged "inny" apply to everyone (PLAN.md 8.1).
      tags: grupa ? [grupa, 'inny'] : undefined,
      sources,
      embedTimeoutMs: Number(process.env.RAG_EMBED_TIMEOUT_MS || 3000),
    });
    const wyniki = hits.map(toWynik);
    const ttl = Number(process.env.RAG_CACHE_TTL_S || 3600);
    await cache.replaceOne(
      { _id: id },
      { wartosc: wyniki, wygasa: new Date(Date.now() + ttl * 1000) },
      { upsert: true },
    );
    return wyniki;
  }
}

function toWynik(h: RagHit): WynikWiedzy {
  const streszczenie = h.summary ?? firstSentences(h.snippet, 2);
  return {
    tytul: h.title,
    glos_streszczenie: streszczenie ? streszczenie.slice(0, MAX_STRESZCZENIE) : null,
    kontakt: h.contact,
    url: h.url,
    zrodlo: ZRODLA_NAZWY[h.source] ?? h.source,
  };
}

export function firstSentences(text: string, n: number): string {
  // Skip the "title – category" header the RAG store puts on each chunk.
  const body = text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2) : text;
  const sentences = body.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g) ?? [body];
  return sentences.slice(0, n).join('').trim();
}
