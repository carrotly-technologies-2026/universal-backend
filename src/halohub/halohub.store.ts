import { Injectable } from '@nestjs/common';
import { Document, ObjectId, WithId } from 'mongodb';
import { MongoService } from '../database/mongo.service.js';
import {
  Bariera,
  IngestRun,
  Kontekst,
  Pomysl,
  Publikacja,
  Raport,
  Rozmowa,
  Temat,
  Zapytanie,
} from './model.js';

export interface KontekstDoc extends Kontekst {
  _id: string;
  zaktualizowano: Date;
  wygasa: Date;
}

export interface CacheDoc {
  _id: string;
  wartosc: unknown;
  wygasa: Date;
}

// Mongo removes expired documents within ~60 s of `wygasa`; readers also
// check the date themselves.
const TTL = { key: { wygasa: 1 }, expireAfterSeconds: 0 };

/** Collections of the Halo, Hub! domain, all prefixed "halohub_". */
@Injectable()
export class HalohubStore {
  constructor(private readonly mongo: MongoService) {}

  rozmowy() {
    return this.mongo.collection<Rozmowa>('halohub_rozmowy', [
      { key: { conversation_id: 1 }, unique: true },
      { key: { utworzono: -1 } },
    ]);
  }

  bariery() {
    return this.mongo.collection<Bariera>('halohub_bariery', [
      { key: { rozmowa_id: 1 } },
      { key: { utworzono: -1 } },
      { key: { kategoria: 1, miejsce: 1 } },
    ]);
  }

  tematy() {
    return this.mongo.collection<Temat>('halohub_tematy', [
      { key: { klucz: 1 }, unique: true },
      { key: { wynik: -1 } },
    ]);
  }

  zapytania() {
    return this.mongo.collection<Zapytanie>('halohub_zapytania', [
      { key: { utworzono: -1 } },
    ]);
  }

  raporty() {
    return this.mongo.collection<Raport>('halohub_raporty', [
      { key: { utworzono: -1 } },
    ]);
  }

  publikacje() {
    return this.mongo.collection<Publikacja>('halohub_publikacje', [
      { key: { status: 1, opublikowano: -1 } },
    ]);
  }

  konteksty() {
    return this.mongo.collection<KontekstDoc>('halohub_konteksty', [TTL]);
  }

  cache() {
    return this.mongo.collection<CacheDoc>('halohub_cache', [TTL]);
  }

  ingest() {
    return this.mongo.collection<IngestRun>('halohub_ingest', [
      { key: { start: -1 } },
    ]);
  }

  pomysly() {
    return this.mongo.collection<Pomysl>('halohub_pomysly', [
      { key: { utworzono: -1 } },
    ]);
  }
}

/** API shape: `_id` becomes `id` (ObjectId and Date serialize themselves). */
export function toApi<T extends Document>(
  doc: WithId<T>,
): Omit<WithId<T>, '_id'> & { id: string } {
  const { _id, ...rest } = doc;
  return { id: String(_id), ...rest };
}

export function parseId(id: string): ObjectId | null {
  return /^[0-9a-f]{24}$/.test(id) ? new ObjectId(id) : null;
}
