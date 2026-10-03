import { BadRequestException, Injectable } from '@nestjs/common';
import { RagService } from '../rag/rag.service.js';
import { HalohubStore, toApi } from './halohub.store.js';
import { computeMetrics, Metryki } from './metrics.js';
import { CORPUS } from './model.js';
import { normalizujMiejsce } from './priority.js';

const DAY_MS = 86_400_000;

export interface Okres {
  od: Date;
  do: Date;
}

/** Parses ?od&do (ISO); defaults to the last `days` days. Max one year. */
export function parseOkres(od?: string, to?: string, days = 7): Okres {
  const end = to ? new Date(to) : new Date();
  const start = od ? new Date(od) : new Date(end.getTime() - days * DAY_MS);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new BadRequestException('od/do must be ISO 8601 dates.');
  }
  if (start >= end || end.getTime() - start.getTime() > 366 * DAY_MS) {
    throw new BadRequestException('od must be before do, at most a year apart.');
  }
  return { od: start, do: end };
}

@Injectable()
export class MetricsService {
  constructor(
    private readonly store: HalohubStore,
    private readonly rag: RagService,
  ) {}

  async compute(okres: Okres, jezyk: string | null = null): Promise<Metryki> {
    const range = { utworzono: { $gte: okres.od, $lt: okres.do } };
    const lang = jezyk ? { jezyk } : {};
    const [rozmowy, bariery, zapytania, tematy] = await Promise.all([
      this.store.rozmowy().then((c) =>
        c
          .find(
            { ...range, ...lang },
            { projection: { transkrypcja: 0, potrzeby: 0, telefon_hash: 0 } },
          )
          .toArray(),
      ),
      this.store.bariery().then((c) =>
        c.find({ ...range, ...lang }, { projection: { opis: 0 } }).toArray(),
      ),
      this.store.zapytania().then((c) => c.find({ ...range, ...lang }).toArray()),
      this.store.tematy().then((c) =>
        c.find(jezyk ? { jezyki: jezyk } : {}, { projection: { innowacje: 0 } }).toArray(),
      ),
    ]);
    return computeMetrics({ od: okres.od, do: okres.do, jezyk, rozmowy, bariery, zapytania, tematy });
  }

  /** Knowledge gaps for the panel (PLAN.md 9.2 "Wiedza"). */
  async luki(okres: Okres) {
    const range = { utworzono: { $gte: okres.od, $lt: okres.do } };
    const [zapytania, rozmowy, ostatni, korpus] = await Promise.all([
      this.store.zapytania().then((c) => c.find(range).toArray()),
      this.store.rozmowy().then((c) =>
        c
          .find(
            { ...range, 'potrzeby.czy_znaleziono': false },
            { projection: { potrzeby: 1 } },
          )
          .toArray(),
      ),
      this.store.ingest().then((c) => c.find().sort({ start: -1 }).limit(1).next()),
      this.rag.stats(CORPUS),
    ]);

    const bezWynikow = groupBy(
      zapytania.filter((z) => z.liczba_wynikow === 0),
      (z) => normalizujMiejsce(z.pytanie),
    ).map((g) => ({
      pytanie: g[0].pytanie,
      liczba: g.length,
      grupy: unique(g.map((z) => z.grupa)),
      jezyki: unique(g.map((z) => z.jezyk)),
      ostatnio: new Date(Math.max(...g.map((z) => z.utworzono.getTime()))),
    }));

    const potrzeby = rozmowy.flatMap((r) => r.potrzeby.filter((p) => !p.czy_znaleziono));
    const nieznalezione = groupBy(potrzeby, (p) => normalizujMiejsce(p.temat)).map((g) => ({
      temat: g[0].temat,
      liczba: g.length,
      grupy: unique(g.map((p) => p.grupa)),
    }));

    const polecane = groupBy(
      zapytania.filter((z) => z.top_url),
      (z) => z.top_url!,
    ).map((g) => ({ url: g[0].top_url!, tytul: g[0].top_tytul, liczba: g.length }));

    const byCount = <T extends { liczba: number }>(xs: T[]) =>
      xs.sort((a, b) => b.liczba - a.liczba).slice(0, 50);
    return {
      pytania_bez_wynikow: byCount(bezWynikow),
      potrzeby_nieznalezione: byCount(nieznalezione),
      polecane: byCount(polecane),
      ingest: { ostatni: ostatni ? toApi(ostatni) : null, korpus },
    };
  }
}

function groupBy<T>(xs: T[], key: (x: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const x of xs) groups.set(key(x), [...(groups.get(key(x)) ?? []), x]);
  return [...groups.values()];
}

function unique(xs: (string | null)[]): string[] {
  return [...new Set(xs.filter((x): x is string => !!x))];
}
