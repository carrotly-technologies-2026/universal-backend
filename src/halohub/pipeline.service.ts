import { Injectable } from '@nestjs/common';
import { RagService } from '../rag/rag.service.js';
import { HalohubStore, toApi } from './halohub.store.js';
import { IngestService } from './ingest/ingest.service.js';
import { dzien } from './metrics.js';
import { CORPUS } from './model.js';

type Status = 'ok' | 'blad' | 'trwa' | 'brak' | 'ostrzezenie';

export interface Etap {
  id: 'ingest' | 'embedding' | 'rozmowy' | 'tematy' | 'raport' | 'publikacja';
  status: Status;
  ostatnio: Date | null;
  nastepny: Date | null;
  metryki: Record<string, number | string | null>;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const warsawHour = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Warsaw',
  hour: 'numeric',
  hourCycle: 'h23',
});

/** State of every stage of the data pipeline, for the panel's Pipeline view. */
@Injectable()
export class PipelineService {
  constructor(
    private readonly store: HalohubStore,
    private readonly rag: RagService,
    private readonly ingest: IngestService,
  ) {}

  async status(now = new Date()) {
    const scheduler = {
      enabled: process.env.HALOHUB_SCHEDULER === 'true',
      report_hour: Number(process.env.HALOHUB_REPORT_HOUR || 7),
      auto_ingest: process.env.HALOHUB_AUTO_INGEST !== 'false',
    };
    const since = { utworzono: { $gte: new Date(now.getTime() - DAY_MS) } };
    const [runs, korpus, rozmowy24, bariery24, pytania24, ostatniaRozmowa, tematy, raporty, ostatniRaport, publikacje, ostatniaPublikacja] =
      await Promise.all([
        this.store.ingest().then((c) => c.find().sort({ start: -1 }).limit(20).toArray()),
        this.rag.stats(CORPUS),
        this.store.rozmowy().then((c) => c.countDocuments(since)),
        this.store.bariery().then((c) => c.countDocuments(since)),
        this.store.zapytania().then((c) => c.countDocuments(since)),
        this.store.rozmowy().then((c) => c.find({}, { projection: { utworzono: 1 } }).sort({ utworzono: -1 }).limit(1).next()),
        this.store.tematy().then((c) =>
          c.aggregate<{ _id: string; n: number; last: Date }>([
            { $match: { aktywny: true } },
            { $group: { _id: '$priorytet', n: { $sum: 1 }, last: { $max: '$zaktualizowano' } } },
          ]).toArray(),
        ),
        this.store.raporty().then((c) => c.countDocuments()),
        this.store.raporty().then((c) => c.find().sort({ utworzono: -1 }).limit(1).next()),
        this.store.publikacje().then((c) =>
          c.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
        ),
        this.store.publikacje().then((c) => c.find().sort({ utworzono: -1 }).limit(1).next()),
      ]);

    const last = runs[0] ?? null;
    const lastOk = runs.find((r) => r.status === 'ok') ?? null;
    const p = (k: string) => tematy.find((t) => t._id === k)?.n ?? 0;
    const tematyLast = tematy.reduce<Date | null>((m, t) => (!m || t.last > m ? t.last : m), null);
    const pub = (k: string) => publikacje.find((x) => x._id === k)?.n ?? 0;
    const sched = (d: Date | null) => (scheduler.enabled ? d : null);

    const etapy: Etap[] = [
      {
        id: 'ingest',
        status: this.ingest.busy || last?.status === 'trwa' ? 'trwa' : last ? (last.status as Status) : 'brak',
        ostatnio: last?.koniec ?? last?.start ?? null,
        nastepny: sched(
          scheduler.auto_ingest ? new Date(Math.max(now.getTime(), (lastOk?.start.getTime() ?? 0) + 7 * DAY_MS)) : null,
        ),
        metryki: {
          dokumenty: korpus.documents,
          zrodla: korpus.sources.length,
          bledy: last?.bledy.length ?? 0,
          czas_s: last?.koniec ? Math.round((last.koniec.getTime() - last.start.getTime()) / 1000) : null,
        },
      },
      {
        id: 'embedding',
        status:
          korpus.chunks === 0 ? 'brak' : korpus.embeddedChunks === korpus.chunks ? 'ok' : 'ostrzezenie',
        ostatnio: korpus.lastFetchedAt,
        nastepny: null,
        metryki: {
          fragmenty: korpus.chunks,
          z_embeddingiem: korpus.embeddedChunks,
          procent: korpus.chunks ? Math.round((korpus.embeddedChunks / korpus.chunks) * 1000) / 1000 : null,
          model: korpus.embeddingModel,
        },
      },
      {
        id: 'rozmowy',
        status: ostatniaRozmowa ? 'ok' : 'brak',
        ostatnio: ostatniaRozmowa?.utworzono ?? null,
        nastepny: null,
        metryki: { rozmowy_24h: rozmowy24, bariery_24h: bariery24, pytania_rag_24h: pytania24 },
      },
      {
        id: 'tematy',
        status: tematyLast ? 'ok' : 'brak',
        ostatnio: tematyLast,
        nastepny: sched(new Date(Math.max(now.getTime(), (tematyLast?.getTime() ?? 0) + HOUR_MS))),
        metryki: { aktywne: p('P1') + p('P2') + p('P3'), p1: p('P1'), p2: p('P2'), p3: p('P3') },
      },
      {
        id: 'raport',
        status: !ostatniRaport ? 'brak' : ostatniRaport.zrodlo === 'llm' ? 'ok' : 'ostrzezenie',
        ostatnio: ostatniRaport?.utworzono ?? null,
        nastepny: sched(nextReport(now, scheduler.report_hour, ostatniRaport?.utworzono ?? null)),
        metryki: { raporty, zrodlo: ostatniRaport?.zrodlo ?? null },
      },
      {
        id: 'publikacja',
        status: pub('opublikowana') ? 'ok' : pub('szkic') ? 'ostrzezenie' : 'brak',
        ostatnio: ostatniaPublikacja?.utworzono ?? null,
        nastepny: null,
        metryki: { szkice: pub('szkic'), opublikowane: pub('opublikowana') },
      },
    ];
    return { scheduler, etapy, ingest_historia: runs.map(toApi) };
  }
}

/** First full hour `hour` (Kraków time) after now on a day without a report yet. */
function nextReport(now: Date, hour: number, last: Date | null): Date {
  const start = Math.ceil(now.getTime() / HOUR_MS) * HOUR_MS;
  for (let t = start; t < start + 3 * DAY_MS; t += HOUR_MS) {
    const d = new Date(t);
    if (Number(warsawHour.format(d)) === hour && (!last || dzien(last) !== dzien(d))) return d;
  }
  return new Date(start);
}
