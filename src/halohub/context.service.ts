import { Injectable, Logger } from '@nestjs/common';
import { withTimeout } from '../rag/rag.service.js';
import { HalohubStore } from './halohub.store.js';
import { Kontekst } from './model.js';

// Long enough to come back to a trip later the same day; the agent decides from
// what the caller says whether this call continues it.
const ttlS = () => Number(process.env.CONTEXT_TTL_S || 6 * 3600);

/**
 * Conversation context per caller (PLAN.md 8.4), keyed by the salted phone
 * hash and expiring CONTEXT_TTL_S (default 6 h) after the last call. Stored in
 * MongoDB with a TTL index instead of Redis. Failures never block a call.
 */
@Injectable()
export class ContextService {
  private readonly logger = new Logger(ContextService.name);

  constructor(private readonly store: HalohubStore) {}

  async save(hash: string, ctx: Kontekst): Promise<void> {
    try {
      const now = new Date();
      await (await this.store.konteksty()).replaceOne(
        { _id: hash },
        {
          ...ctx,
          zaktualizowano: now,
          wygasa: new Date(now.getTime() + ttlS() * 1000),
        },
        { upsert: true },
      );
    } catch (err) {
      this.logger.warn(`Context save failed: ${String(err)}`);
    }
  }

  /**
   * Merges `ctx` into the stored context (null fields keep the stored value);
   * with `tylkoBraki` only the stored gaps are filled. Used during a call and
   * for continuations, so a short follow-up call never wipes the trip.
   */
  async merge(hash: string, ctx: Kontekst, opts: { tylkoBraki?: boolean } = {}): Promise<void> {
    const prev = await this.get(hash);
    await this.save(hash, prev ? mergeKontekst(prev, ctx, opts) : ctx);
  }

  /** Stored context without the voice-latency timeout (webhooks and tools). */
  async get(hash: string): Promise<(Kontekst & { zaktualizowano?: Date }) | null> {
    try {
      return await (await this.store.konteksty()).findOne({ _id: hash, wygasa: { $gt: new Date() } });
    } catch (err) {
      this.logger.warn(`Context read failed: ${String(err)}`);
      return null;
    }
  }

  /** The caller started a new matter: forget the previous one. */
  async discard(hash: string): Promise<boolean> {
    try {
      const { deletedCount } = await (await this.store.konteksty()).deleteOne({ _id: hash });
      return deletedCount > 0;
    } catch (err) {
      this.logger.warn(`Context discard failed: ${String(err)}`);
      return false;
    }
  }

  async load(hash: string): Promise<(Kontekst & { zaktualizowano?: Date }) | null> {
    try {
      const doc = await withTimeout(
        this.store.konteksty().then((c) =>
          c.findOne({ _id: hash, wygasa: { $gt: new Date() } }),
        ),
        // ElevenLabs waits a few seconds for the initiation webhook; a cold
        // connection can take longer than a warm query, so do not give up early.
        Number(process.env.CONTEXT_TIMEOUT_MS || 1500),
      );
      return doc;
    } catch (err) {
      this.logger.warn(`Context load failed: ${String(err)}`);
      return null;
    }
  }
}

const POLA = ['cel_podrozy', 'typ_uzytkownika', 'jezyk', 'ostatni_krok', 'podsumowanie', 'czy_dotarl'] as const;

/**
 * `update` over `base`, field by field; empty values never erase. With
 * `tylkoBraki` `base` wins and `update` only fills its gaps.
 */
export function mergeKontekst(base: Kontekst, update: Kontekst, opts: { tylkoBraki?: boolean } = {}): Kontekst {
  const [first, second] = opts.tylkoBraki ? [base, update] : [update, base];
  const out: Kontekst = { conversation_id: first.conversation_id || second.conversation_id } as Kontekst;
  for (const k of POLA) {
    const a = first[k];
    (out as unknown as Record<string, unknown>)[k] = a !== null && a !== undefined && a !== '' ? a : (second[k] ?? null);
  }
  return out;
}

const OSOBA: Record<string, string> = {
  senior: 'senior',
  wozek: 'wózek',
  chodzik: 'chodzik',
  wozek_dzieciecy: 'wózek dziecięcy',
  bagaz: 'duży bagaż',
  obcokrajowiec: 'obcokrajowiec',
  nowy_w_miescie: 'nowy w Krakowie',
};

/** First message for new callers: introduces the project (same as FIRST_MESSAGE.pl in agent/sync.mjs). */
export const POWITANIE =
  'Dzień dobry, tu MayAI z Halo, Hub! – telefonicznej asystentki dla każdego w Krakowie. Poprowadzę tramwajem lub autobusem krok po kroku, podpowiem, co zobaczyć i gdzie zjeść, jak załatwić sprawę w urzędzie i gdzie szukać pomocy. A trudności, o których mi pan lub pani powie, przekażę anonimowo miastu. W czym mogę pomóc?';

/** Returning callers already know the line: short greeting in their language. */
const POWITANIE_POWROT: Record<string, string> = {
  pl: 'Dzień dobry, tu znowu MayAI z Halo, Hub!. Słucham, w czym mogę pomóc?',
  uk: 'Добрий день, це знову MayAI з Halo, Hub!. Слухаю, чим можу допомогти?',
  en: 'Hello again, this is MayAI from Halo, Hub!. How can I help?',
};

/** dynamic_variables for the conversation-initiation webhook. */
export function dynamicVariables(
  ctx: (Kontekst & { zaktualizowano?: Date }) | null,
  now = new Date(),
) {
  if (!ctx) return { czy_powrot: 'nie', poprzedni_kontekst: '', powitanie: POWITANIE };
  const parts: string[] = [];
  if (ctx.zaktualizowano) {
    const min = Math.max(1, Math.round((now.getTime() - ctx.zaktualizowano.getTime()) / 60_000));
    parts.push(min < 120 ? `Rozmowa sprzed ${min} min.` : `Rozmowa sprzed ok. ${Math.round(min / 60)} godz.`);
  }
  if (ctx.cel_podrozy) parts.push(`Cel: ${ctx.cel_podrozy}.`);
  const osoba = ctx.typ_uzytkownika && OSOBA[ctx.typ_uzytkownika];
  if (osoba) parts.push(`Rozmówca: ${osoba}.`);
  if (ctx.jezyk) parts.push(`Język poprzedniej rozmowy: ${ctx.jezyk}.`);
  if (ctx.podsumowanie) parts.push(ctx.podsumowanie);
  parts.push(`Ostatni krok: ${ctx.ostatni_krok || 'brak'}.`);
  if (ctx.czy_dotarl) parts.push('Trasa zakończona.');
  return {
    czy_powrot: 'tak',
    poprzedni_kontekst: parts.join(' '),
    powitanie: POWITANIE_POWROT[ctx.jezyk ?? ''] ?? POWITANIE_POWROT.pl,
  };
}
