import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { ContextService } from './context.service.js';
import {
  bool,
  hashTelefonu,
  jezyk,
  parseBariery,
  parsePotrzeby,
  PostCall,
  str,
  typUzytkownika,
} from './elevenlabs.js';
import { HalohubStore, parseId, toApi } from './halohub.store.js';
import { Bariera, Rozmowa } from './model.js';

/** Without a salt, phone hashes could be reversed by brute force: refuse. */
export function phoneSalt(): string {
  const salt = process.env.PHONE_HASH_SALT;
  if (!salt) {
    throw new ServiceUnavailableException('Disabled: set PHONE_HASH_SALT.');
  }
  return salt;
}

/** Turns a post-call webhook into a conversation, its barriers and the caller's context. */
@Injectable()
export class ConversationService {
  constructor(
    private readonly store: HalohubStore,
    private readonly context: ContextService,
  ) {}

  /** Idempotent: ElevenLabs retries replace the stored conversation. */
  async savePostCall(
    call: PostCall,
    demo = false,
  ): Promise<{ rozmowaId: ObjectId; bariery: number }> {
    const val = (k: string) => call.pola[k] ?? null;
    const telefonHash = call.callerId
      ? hashTelefonu(call.callerId, phoneSalt())
      : null;
    const rozmowa: Omit<Rozmowa, '_id'> = {
      conversation_id: call.conversationId,
      telefon_hash: telefonHash,
      typ_uzytkownika: typUzytkownika(val('typ_uzytkownika')),
      jezyk: jezyk(val('jezyk_rozmowy')),
      cel_podrozy: str(val('cel_podrozy'), 200),
      czy_dotarl: bool(val('czy_dotarl')),
      czas_trwania_s: call.czasTrwaniaS,
      czy_powrot: call.czyPowrot,
      potrzeby: parsePotrzeby(val('potrzeby_json')),
      transkrypcja: call.transkrypcja,
      demo,
      utworzono: call.rozpoczeto ?? new Date(),
    };

    const rozmowy = await this.store.rozmowy();
    const saved = await rozmowy.findOneAndUpdate(
      { conversation_id: call.conversationId },
      { $set: rozmowa },
      { upsert: true, returnDocument: 'after' },
    );
    const rozmowaId = saved!._id;

    const bariery = await this.store.bariery();
    await bariery.deleteMany({ rozmowa_id: rozmowaId });
    const nowe: Omit<Bariera, '_id'>[] = parseBariery(val('problemy_json')).map(
      (b) => ({
        ...b,
        rozmowa_id: rozmowaId,
        telefon_hash: telefonHash,
        jezyk: rozmowa.jezyk,
        typ_uzytkownika: rozmowa.typ_uzytkownika,
        demo,
        utworzono: rozmowa.utworzono,
      }),
    );
    if (nowe.length) await bariery.insertMany(nowe as Bariera[]);

    if (telefonHash && !demo) {
      const ctx = {
        conversation_id: call.conversationId,
        cel_podrozy: rozmowa.cel_podrozy,
        typ_uzytkownika: rozmowa.typ_uzytkownika,
        jezyk: rozmowa.jezyk,
        ostatni_krok: str(val('ostatni_krok'), 300),
        podsumowanie: str(val('kontekst_podsumowanie'), 1000),
        czy_dotarl: rozmowa.czy_dotarl,
      };
      const prev = await this.context.get(telefonHash);
      const start = call.rozpoczeto?.getTime() ?? Date.now();
      const koniec = start + (call.czasTrwaniaS ?? 0) * 1000;
      if (!prev) await this.context.save(telefonHash, ctx);
      else if (
        prev.conversation_id !== call.conversationId &&
        prev.zaktualizowano &&
        prev.zaktualizowano.getTime() > koniec
      ) {
        // A later call already stored progress (redial before this webhook arrived).
        await this.context.merge(telefonHash, ctx, { tylkoBraki: true });
      } else if (prev.conversation_id === call.conversationId || call.czyPowrot) {
        // Progress saved during this call, or a continuation of the previous one.
        await this.context.merge(telefonHash, ctx);
      } else await this.context.save(telefonHash, ctx);
    }
    return { rozmowaId, bariery: nowe.length };
  }

  /** One call with its transcript, barriers, RAG questions and the caller's other calls. */
  async detail(id: string) {
    const _id = parseId(id);
    const rozmowy = await this.store.rozmowy();
    const r = _id && (await rozmowy.findOne({ _id }));
    if (!r) throw new NotFoundException('Conversation not found.');
    const [bariery, zapytania, poprzednie] = await Promise.all([
      this.store.bariery().then((c) =>
        c.find({ rozmowa_id: r._id }, { projection: { telefon_hash: 0, rozmowa_id: 0 } }).toArray(),
      ),
      this.store.zapytania().then((c) =>
        c.find({ conversation_id: r.conversation_id }).sort({ utworzono: 1 }).toArray(),
      ),
      r.telefon_hash
        ? rozmowy
            .find(
              { telefon_hash: r.telefon_hash, _id: { $ne: r._id } },
              { projection: { transkrypcja: 0, telefon_hash: 0, potrzeby: 0 } },
            )
            .sort({ utworzono: -1 })
            .limit(10)
            .toArray()
        : [],
    ]);
    // The phone hash never leaves the backend.
    const { telefon_hash: _hash, ...rest } = r;
    return {
      ...toApi(rest as typeof r),
      liczba_barier: bariery.length,
      bariery: bariery.map(toApi),
      zapytania_rag: zapytania.map(toApi),
      poprzednie: poprzednie.map(toApi),
    };
  }

  async recent(limit: number) {
    const rozmowy = await this.store.rozmowy();
    const list = await rozmowy
      .find({}, { projection: { transkrypcja: 0, telefon_hash: 0, potrzeby: 0 } })
      .sort({ utworzono: -1 })
      .limit(limit)
      .toArray();
    const counts = await (await this.store.bariery())
      .aggregate<{ _id: ObjectId; n: number }>([
        { $match: { rozmowa_id: { $in: list.map((r) => r._id) } } },
        { $group: { _id: '$rozmowa_id', n: { $sum: 1 } } },
      ])
      .toArray();
    const byId = new Map(counts.map((c) => [c._id.toHexString(), c.n]));
    return list.map(({ _id, ...r }) => ({
      id: _id.toHexString(),
      ...r,
      liczba_barier: byId.get(_id.toHexString()) ?? 0,
    }));
  }
}
