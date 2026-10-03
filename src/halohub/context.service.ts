import { Injectable, Logger } from '@nestjs/common';
import { withTimeout } from '../rag/rag.service.js';
import { HalohubStore } from './halohub.store.js';
import { Kontekst } from './model.js';

const ttlS = () => Number(process.env.CONTEXT_TTL_S || 3600);

/**
 * Short conversation context per caller (PLAN.md 8.4), keyed by the salted
 * phone hash and expiring an hour after the last call. Stored in MongoDB with
 * a TTL index instead of Redis. Failures never block a call.
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

  async load(hash: string): Promise<Kontekst | null> {
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
export function dynamicVariables(ctx: Kontekst | null) {
  return {
    czy_powrot: ctx ? 'tak' : 'nie',
    poprzedni_kontekst: ctx
      ? `${ctx.podsumowanie ?? ''} Ostatni krok: ${ctx.ostatni_krok || 'brak'}.${ctx.czy_dotarl ? ' Trasa zakończona.' : ''}`.trim()
      : '',
  };
}
