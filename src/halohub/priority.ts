import { Bariera, Kategoria, Priorytet } from './model.js';

/**
 * Priority weights (PLAN.md 8.6). Kept together so they are easy to tune.
 *
 *   wynik = Σ [ waga_powagi × waga_grupy × waga_swiezosci ]
 *           × (1 + clamp(trend_7d − 1, −0.5, 1))
 *           × (1 + 0.2 × (liczba_jezykow − 1))
 *
 * The plan has no lower bound on the trend factor; without one a topic
 * with no reports this week but many before would score 0, so it is
 * clamped to halve the score at most.
 */
export const WAGI = {
  powaga: { 1: 1, 2: 2, 3: 4 } as Record<number, number>,
  grupa: {
    wozek: 1.5,
    chodzik: 1.5,
    senior: 1.5,
    obcokrajowiec: 1.2,
    wozek_dzieciecy: 1.2,
  } as Record<string, number>,
  swiezosc: { do7dni: 1, starsze: 0.5 },
  jezyk: 0.2,
  progi: { P1: 12, P2: 5 },
  /** P1 also when this many distinct people reported severity 3. */
  osobyPowaga3: 2,
  oknoDni: 30,
};

export const ETYKIETY_KATEGORII: Record<Kategoria, string> = {
  BARIERA_FIZYCZNA: 'Bariera fizyczna',
  AWARIA: 'Awaria',
  OZNAKOWANIE: 'Oznakowanie',
  KOMUNIKACJA_MIEJSKA: 'Komunikacja miejska',
  JEZYK: 'Język',
  INFORMACJA: 'Informacja',
  ODPOCZYNEK_I_TOALETY: 'Odpoczynek i toalety',
  BEZPIECZENSTWO: 'Bezpieczeństwo',
  ORIENTACJA: 'Orientacja',
  INNE: 'Inne',
};

const DAY_MS = 86_400_000;

/** Lowercase, no Polish diacritics, no "ul."/"al."/"pl.", single spaces. */
export function normalizujMiejsce(miejsce: string): string {
  return miejsce
    .toLowerCase()
    .replaceAll('ł', 'l')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\b(ul|al|pl|os|ulica|aleja|plac)\b\.?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export const kluczTematu = (kategoria: string, miejsce: string) =>
  `${kategoria}|${normalizujMiejsce(miejsce)}`;

export type BarieraDoTematu = Pick<
  Bariera,
  | 'kategoria'
  | 'miejsce'
  | 'dzielnica'
  | 'powaga'
  | 'dotyczy'
  | 'jezyk'
  | 'typ_uzytkownika'
  | 'telefon_hash'
  | 'rozmowa_id'
  | 'demo'
  | 'utworzono'
>;

export interface WyliczonyTemat {
  klucz: string;
  tytul: string;
  kategoria: Kategoria;
  miejsce: string;
  dzielnica: string | null;
  liczba_zgloszen: number;
  liczba_osob: number;
  sr_powaga: number;
  grupy: string[];
  jezyki: string[];
  trend_7d: number;
  wynik: number;
  priorytet: Priorytet;
  rozbicie: string;
  pierwsze_zgloszenie: Date;
  ostatnie_zgloszenie: Date;
  demo: boolean;
}

/** Groups barriers of the 30-day window into topics and scores them. */
export function wyliczTematy(
  bariery: BarieraDoTematu[],
  now: Date,
): WyliczonyTemat[] {
  const since = now.getTime() - WAGI.oknoDni * DAY_MS;
  const groups = new Map<string, BarieraDoTematu[]>();
  for (const b of bariery) {
    if (b.utworzono.getTime() < since || !normalizujMiejsce(b.miejsce)) continue;
    const k = kluczTematu(b.kategoria, b.miejsce);
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  return [...groups].map(([klucz, bs]) => wyliczTemat(klucz, bs, now));
}

function wyliczTemat(
  klucz: string,
  bs: BarieraDoTematu[],
  now: Date,
): WyliczonyTemat {
  const t = now.getTime();
  const age = (b: BarieraDoTematu) => t - b.utworzono.getTime();
  const grupyZgloszenia = (b: BarieraDoTematu) =>
    unique([...b.dotyczy, b.typ_uzytkownika].filter((g): g is string => !!g));

  let suma = 0;
  for (const b of bs) {
    const wagaGrupy = Math.max(
      1,
      ...grupyZgloszenia(b).map((g) => WAGI.grupa[g] ?? 1),
    );
    const swiezosc =
      age(b) <= 7 * DAY_MS ? WAGI.swiezosc.do7dni : WAGI.swiezosc.starsze;
    suma += (WAGI.powaga[b.powaga] ?? 1) * wagaGrupy * swiezosc;
  }

  const last7 = bs.filter((b) => age(b) <= 7 * DAY_MS).length;
  const prev7 = bs.filter((b) => age(b) > 7 * DAY_MS && age(b) <= 14 * DAY_MS).length;
  const trend = prev7 === 0 ? (last7 > 0 ? 2 : 1) : last7 / prev7;
  const trendFactor = 1 + Math.min(Math.max(trend - 1, -0.5), 1);
  const jezyki = unique(bs.map((b) => b.jezyk).filter((j): j is string => !!j));
  const jezykFactor = 1 + WAGI.jezyk * Math.max(jezyki.length - 1, 0);
  const wynik = round(suma * trendFactor * jezykFactor, 1);

  const person = (b: BarieraDoTematu) =>
    b.telefon_hash ?? b.rozmowa_id.toHexString();
  const osoby = new Set(bs.map(person)).size;
  const osobyPowaga3 = new Set(bs.filter((b) => b.powaga === 3).map(person)).size;
  const priorytet: Priorytet =
    wynik >= WAGI.progi.P1 || osobyPowaga3 >= WAGI.osobyPowaga3
      ? 'P1'
      : wynik >= WAGI.progi.P2
        ? 'P2'
        : 'P3';

  const miejsce = mostCommon(bs.map((b) => b.miejsce.trim()));
  const kategoria = bs[0].kategoria;
  const srPowaga = round(bs.reduce((n, b) => n + b.powaga, 0) / bs.length, 1);
  const grupy = unique(bs.flatMap(grupyZgloszenia));
  const times = bs.map((b) => b.utworzono.getTime());

  const parts = [
    `${bs.length} ${plural(bs.length, 'zgłoszenie', 'zgłoszenia', 'zgłoszeń')} (${osoby} ${plural(osoby, 'osoba', 'osoby', 'osób')})`,
    `śr. powaga ${srPowaga}`,
  ];
  const wrazliwe = grupy.filter((g) => WAGI.grupa[g]);
  if (wrazliwe.length) parts.push(`grupy: ${wrazliwe.join(', ')}`);
  parts.push(`suma wag ${round(suma, 1)}`);
  if (trendFactor !== 1) parts.push(`trend ×${round(trendFactor, 2)}`);
  if (jezykFactor !== 1) parts.push(`${jezyki.length} języki ×${round(jezykFactor, 2)}`);
  if (osobyPowaga3 >= WAGI.osobyPowaga3) {
    parts.push(`powaga 3 od ${osobyPowaga3} osób → P1`);
  }

  return {
    klucz,
    tytul: `${ETYKIETY_KATEGORII[kategoria]} · ${miejsce}`,
    kategoria,
    miejsce,
    dzielnica: mostCommon(bs.map((b) => b.dzielnica).filter((d): d is string => !!d)) || null,
    liczba_zgloszen: bs.length,
    liczba_osob: osoby,
    sr_powaga: srPowaga,
    grupy,
    jezyki,
    trend_7d: round(trend, 2),
    wynik,
    priorytet,
    rozbicie: `${parts.join(' · ')} = ${wynik}`,
    pierwsze_zgloszenie: new Date(Math.min(...times)),
    ostatnie_zgloszenie: new Date(Math.max(...times)),
    // Any demo report taints the topic, so it never goes out unlabelled.
    demo: bs.some((b) => b.demo),
  };
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function mostCommon(xs: string[]): string {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const mod10 = n % 10;
  const mod100 = n % 100;
  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
}
