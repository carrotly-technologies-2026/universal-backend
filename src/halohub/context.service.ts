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
        Number(process.env.CONTEXT_TIMEOUT_MS || 300),
      );
      return doc;
    } catch (err) {
      this.logger.warn(`Context load failed: ${String(err)}`);
      return null;
    }
  }
}

/** dynamic_variables for the conversation-initiation webhook. */
export function dynamicVariables(
  ctx: (Kontekst & { zaktualizowano?: Date }) | null,
  now = new Date(),
) {
  if (!ctx) return { czy_powrot: 'nie', poprzedni_kontekst: '' };
  const parts: string[] = [];
  if (ctx.zaktualizowano) {
    const min = Math.max(1, Math.round((now.getTime() - ctx.zaktualizowano.getTime()) / 60_000));
    parts.push(min < 120 ? `Rozmowa sprzed ${min} min.` : `Rozmowa sprzed ok. ${Math.round(min / 60)} godz.`);
  }
  if (ctx.cel_podrozy) parts.push(`Cel: ${ctx.cel_podrozy}.`);
  if (ctx.podsumowanie) parts.push(ctx.podsumowanie);
  parts.push(`Ostatni krok: ${ctx.ostatni_krok || 'brak'}.`);
  if (ctx.czy_dotarl) parts.push('Trasa zakończona.');
  return { czy_powrot: 'tak', poprzedni_kontekst: parts.join(' ') };
}
