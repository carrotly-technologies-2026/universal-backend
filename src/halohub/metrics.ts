import {
  Bariera,
  GRUPY_WRAZLIWE,
  Priorytet,
  Rozmowa,
  Temat,
  WERSJA_DEFINICJI,
  Zapytanie,
} from './model.js';

/** Counts per key. Unknown values are counted under "nieznany". */
export type Podzial = Record<string, number>;
/** Ratios are fractions 0–1; null when there is nothing to divide by. */
export type Udzial = number | null;

/** Reportable metrics, PLAN.md section 9.5. Same shape in panel, report and open data. */
export interface Metryki {
  okres_od: string;
  okres_do: string;
  jezyk: string | null;
  wersja_definicji: string;
  /** True if any counted record is demo data ("dane przykładowe"). */
  demo: boolean;
  rozmowy: {
    razem: number;
    wg_jezyka: Podzial;
    wg_typu: Podzial;
    wg_dnia: { dzien: string; liczba: number }[];
  };
  mediana_czasu_s: { razem: number | null; wg_jezyka: Record<string, number | null> };
  odsetek_dotarlo: {
    razem: Udzial;
    wg_jezyka: Record<string, Udzial>;
    wg_typu: Record<string, Udzial>;
  };
  ponowne_telefony: { razem: Udzial; wg_jezyka: Record<string, Udzial> };
  bariery: {
    razem: number;
    wg_kategorii: Podzial;
    wg_dzielnicy: Podzial;
    wg_powagi: Podzial;
    wg_jezyka: Podzial;
    wg_dnia: { dzien: string; liczba: number }[];
  };
  udzial_grup_wrazliwych: Udzial;
  tematy_p1: { razem: number; wg_kategorii: Podzial; wg_dzielnicy: Podzial };
  tematy_p2: { razem: number; wg_kategorii: Podzial; wg_dzielnicy: Podzial };
  czas_reakcji_dni: {
    razem: number | null;
    wg_priorytetu: Record<Priorytet, number | null>;
  };
  naprawione: { razem: number; wg_kategorii: Podzial };
  bariery_jezykowe: { razem: number; wg_jezyka: Podzial };
  /** odsetek_dotarlo(pl) − odsetek_dotarlo(other languages), percentage points. */
  luka_jezykowa_dotarcia: number | null;
  pytania_rag: { razem: number; wg_grupy: Podzial; wg_jezyka: Podzial };
  odsetek_bez_wynikow: { razem: Udzial; wg_grupy: Record<string, Udzial> };
}

export type RozmowaDoMetryk = Pick<
  Rozmowa,
  | 'jezyk'
  | 'typ_uzytkownika'
  | 'cel_podrozy'
  | 'czy_dotarl'
  | 'czas_trwania_s'
  | 'czy_powrot'
  | 'demo'
  | 'utworzono'
>;
export type BarieraDoMetryk = Pick<
  Bariera,
  | 'kategoria'
  | 'dzielnica'
  | 'powaga'
  | 'jezyk'
  | 'typ_uzytkownika'
  | 'dotyczy'
  | 'demo'
  | 'utworzono'
>;
export type TematDoMetryk = Pick<
  Temat,
  | 'priorytet'
  | 'status'
  | 'kategoria'
  | 'dzielnica'
  | 'historia'
  | 'pierwsze_zgloszenie'
  | 'aktywny'
  | 'demo'
>;
export type ZapytanieDoMetryk = Pick<
  Zapytanie,
  'grupa' | 'jezyk' | 'liczba_wynikow' | 'demo'
>;

export interface MetrykiInput {
  od: Date;
  do: Date;
  jezyk: string | null;
  /** Already filtered to the period (and language, if any). */
  rozmowy: RozmowaDoMetryk[];
  bariery: BarieraDoMetryk[];
  zapytania: ZapytanieDoMetryk[];
  /** All topics: open counts are a current state, not a period. */
  tematy: TematDoMetryk[];
}

const NIEZNANY = 'nieznany';
const DAY_MS = 86_400_000;
const OTWARTE = (t: TematDoMetryk) =>
  t.aktywny && t.status !== 'naprawiony' && t.status !== 'odrzucony';

export function computeMetrics(i: MetrykiInput): Metryki {
  const { rozmowy: r, bariery: b, zapytania: z } = i;
  const inPeriod = (d: Date) => d >= i.od && d < i.do;
  const zCelem = r.filter((x) => x.cel_podrozy);
  const dotarlo = (xs: RozmowaDoMetryk[]) =>
    ratio(xs.filter((x) => x.czy_dotarl === true).length, xs.length);
  const plDotarlo = dotarlo(zCelem.filter((x) => x.jezyk === 'pl'));
  const inneDotarlo = dotarlo(zCelem.filter((x) => x.jezyk && x.jezyk !== 'pl'));

  const open = (p: Priorytet) => {
    const ts = i.tematy.filter((t) => t.priorytet === p && OTWARTE(t));
    return {
      razem: ts.length,
      wg_kategorii: countBy(ts, (t) => t.kategoria),
      wg_dzielnicy: countBy(ts, (t) => t.dzielnica),
    };
  };

  const firstTransition = (t: TematDoMetryk, status: string) =>
    t.historia.find((h) => h.status === status)?.kiedy;
  const planned = i.tematy
    .map((t) => ({ t, kiedy: firstTransition(t, 'zaplanowany') }))
    .filter((x) => x.kiedy && inPeriod(x.kiedy));
  const reactionDays = (xs: typeof planned) =>
    median(
      xs.map(
        (x) => (x.kiedy!.getTime() - x.t.pierwsze_zgloszenie.getTime()) / DAY_MS,
      ),
    );
  const fixed = i.tematy.filter((t) => {
    const kiedy = firstTransition(t, 'naprawiony');
    return t.status === 'naprawiony' && kiedy && inPeriod(kiedy);
  });

  const jezykowe = b.filter((x) => x.kategoria === 'JEZYK');
  const bezWynikow = (xs: ZapytanieDoMetryk[]) =>
    ratio(xs.filter((x) => x.liczba_wynikow === 0).length, xs.length);

  return {
    okres_od: i.od.toISOString(),
    okres_do: i.do.toISOString(),
    jezyk: i.jezyk,
    wersja_definicji: WERSJA_DEFINICJI,
    demo: [...r, ...b, ...z].some((x) => x.demo),
    rozmowy: {
      razem: r.length,
      wg_jezyka: countBy(r, (x) => x.jezyk),
      wg_typu: countBy(r, (x) => x.typ_uzytkownika),
      wg_dnia: perDay(r, i.od, i.do),
    },
    mediana_czasu_s: {
      razem: median(r.map((x) => x.czas_trwania_s)),
      wg_jezyka: mapGroups(r, (x) => x.jezyk, (xs) =>
        median(xs.map((x) => x.czas_trwania_s)),
      ),
    },
    odsetek_dotarlo: {
      razem: dotarlo(zCelem),
      wg_jezyka: mapGroups(zCelem, (x) => x.jezyk, dotarlo),
      wg_typu: mapGroups(zCelem, (x) => x.typ_uzytkownika, dotarlo),
    },
    ponowne_telefony: {
      razem: ratio(r.filter((x) => x.czy_powrot).length, r.length),
      wg_jezyka: mapGroups(r, (x) => x.jezyk, (xs) =>
        ratio(xs.filter((x) => x.czy_powrot).length, xs.length),
      ),
    },
    bariery: {
      razem: b.length,
      wg_kategorii: countBy(b, (x) => x.kategoria),
      wg_dzielnicy: countBy(b, (x) => x.dzielnica),
      wg_powagi: countBy(b, (x) => String(x.powaga)),
      wg_jezyka: countBy(b, (x) => x.jezyk),
      wg_dnia: perDay(b, i.od, i.do),
    },
    udzial_grup_wrazliwych: ratio(
      // "od" grup wrażliwych: reported by such callers (PLAN.md 9.5).
      b.filter((x) => GRUPY_WRAZLIWE.includes(x.typ_uzytkownika ?? '')).length,
      b.length,
    ),
    tematy_p1: open('P1'),
    tematy_p2: open('P2'),
    czas_reakcji_dni: {
      razem: round(reactionDays(planned), 1),
      wg_priorytetu: {
        P1: round(reactionDays(planned.filter((x) => x.t.priorytet === 'P1')), 1),
        P2: round(reactionDays(planned.filter((x) => x.t.priorytet === 'P2')), 1),
        P3: round(reactionDays(planned.filter((x) => x.t.priorytet === 'P3')), 1),
      },
    },
    naprawione: {
      razem: fixed.length,
      wg_kategorii: countBy(fixed, (t) => t.kategoria),
    },
    bariery_jezykowe: {
      razem: jezykowe.length,
      wg_jezyka: countBy(jezykowe, (x) => x.jezyk),
    },
    luka_jezykowa_dotarcia:
      plDotarlo === null || inneDotarlo === null
        ? null
        : round((plDotarlo - inneDotarlo) * 100, 1),
    pytania_rag: {
      razem: z.length,
      wg_grupy: countBy(z, (x) => x.grupa),
      wg_jezyka: countBy(z, (x) => x.jezyk),
    },
    odsetek_bez_wynikow: {
      razem: bezWynikow(z),
      wg_grupy: mapGroups(z, (x) => x.grupa, bezWynikow),
    },
  };
}

function key(v: string | null | undefined): string {
  return v || NIEZNANY;
}

function countBy<T>(xs: T[], f: (x: T) => string | null | undefined): Podzial {
  const out: Podzial = {};
  for (const x of xs) out[key(f(x))] = (out[key(f(x))] ?? 0) + 1;
  return out;
}

function mapGroups<T, R>(
  xs: T[],
  f: (x: T) => string | null | undefined,
  agg: (group: T[]) => R,
): Record<string, R> {
  const groups = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(f(x));
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  return Object.fromEntries([...groups].map(([k, g]) => [k, agg(g)]));
}

function ratio(n: number, d: number): Udzial {
  return d === 0 ? null : round(n / d, 4);
}

export function median(values: (number | null | undefined)[]): number | null {
  const xs = values
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function round(v: number | null, digits: number): number | null {
  if (v === null) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

const warsawDay = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Warsaw',
});

/** Calendar day in Kraków, YYYY-MM-DD. */
export const dzien = (d: Date) => warsawDay.format(d);

/** Every day of the period, including days with zero. */
function perDay(xs: { utworzono: Date }[], od: Date, to: Date) {
  const counts = countBy(xs, (x) => dzien(x.utworzono));
  const days: string[] = [];
  const start = od.getTime();
  for (let t = start; t < to.getTime(); t += DAY_MS) {
    const d = dzien(new Date(t));
    if (days.at(-1) !== d) days.push(d);
  }
  const last = dzien(new Date(to.getTime() - 1));
  if (days.at(-1) !== last) days.push(last);
  return days.map((d) => ({ dzien: d, liczba: counts[d] ?? 0 }));
}
