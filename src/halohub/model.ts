import { ObjectId } from 'mongodb';

/** Halo, Hub! domain model (PLAN.md sections 5, 8.1). Field names follow the plan. */

export const KATEGORIE = [
  'BARIERA_FIZYCZNA',
  'AWARIA',
  'OZNAKOWANIE',
  'KOMUNIKACJA_MIEJSKA',
  'JEZYK',
  'INFORMACJA',
  'ODPOCZYNEK_I_TOALETY',
  'BEZPIECZENSTWO',
  'ORIENTACJA',
  'INNE',
] as const;
export type Kategoria = (typeof KATEGORIE)[number];

export const TYPY_UZYTKOWNIKA = [
  'senior',
  'wozek',
  'chodzik',
  'wozek_dzieciecy',
  'bagaz',
  'obcokrajowiec',
  'nowy_w_miescie',
  'inny',
] as const;
export type TypUzytkownika = (typeof TYPY_UZYTKOWNIKA)[number];

/** Groups counted in `udzial_grup_wrazliwych`. */
export const GRUPY_WRAZLIWE: readonly string[] = ['senior', 'wozek', 'chodzik'];

export const STATUSY = [
  'nowy',
  'w_analizie',
  'zaplanowany',
  'naprawiony',
  'odrzucony',
] as const;
export type StatusTematu = (typeof STATUSY)[number];

export type Priorytet = 'P1' | 'P2' | 'P3';
export const JEZYKI_RAPORTU = ['pl', 'en', 'uk'] as const;
export type JezykRaportu = (typeof JEZYKI_RAPORTU)[number];

export interface Potrzeba {
  temat: string;
  grupa: string | null;
  czy_znaleziono: boolean;
}

export interface Rozmowa {
  _id: ObjectId;
  conversation_id: string;
  telefon_hash: string | null;
  typ_uzytkownika: string | null;
  jezyk: string | null;
  cel_podrozy: string | null;
  czy_dotarl: boolean | null;
  czas_trwania_s: number | null;
  czy_powrot: boolean;
  potrzeby: Potrzeba[];
  transkrypcja: unknown;
  demo: boolean;
  utworzono: Date;
}

export interface Bariera {
  _id: ObjectId;
  rozmowa_id: ObjectId;
  /** Hash of the caller, to count distinct people per topic. */
  telefon_hash: string | null;
  kategoria: Kategoria;
  opis: string;
  miejsce: string;
  dzielnica: string | null;
  powaga: 1 | 2 | 3;
  dotyczy: string[];
  /** Copied from the conversation so aggregations need no join. */
  jezyk: string | null;
  typ_uzytkownika: string | null;
  demo: boolean;
  utworzono: Date;
}

export interface Innowacja {
  tytul: string;
  url: string;
  glos_streszczenie: string | null;
  kontakt: string | null;
  zrodlo: string;
}

export interface Temat {
  _id: ObjectId;
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
  /** Human-readable score breakdown shown next to the score. */
  rozbicie: string;
  status: StatusTematu;
  notatka: string | null;
  historia: { status: StatusTematu; kiedy: Date }[];
  innowacje: Innowacja[];
  innowacje_odswiezono: Date | null;
  pierwsze_zgloszenie: Date;
  ostatnie_zgloszenie: Date;
  /** False once no barrier of the topic is in the 30-day window. */
  aktywny: boolean;
  demo: boolean;
  zaktualizowano: Date;
}

export interface Zapytanie {
  _id: ObjectId;
  conversation_id: string | null;
  pytanie: string;
  grupa: string | null;
  jezyk: string | null;
  liczba_wynikow: number;
  top_url: string | null;
  top_tytul: string | null;
  demo: boolean;
  utworzono: Date;
}

export interface Raport {
  _id: ObjectId;
  okres_od: Date;
  okres_do: Date;
  tresc_md: Partial<Record<JezykRaportu, string>>;
  /** 'llm' or 'szablon' when the model was unavailable. */
  zrodlo: 'llm' | 'szablon';
  utworzono: Date;
}

export interface Publikacja {
  _id: ObjectId;
  raport_id: ObjectId | null;
  okres_od: Date;
  okres_do: Date;
  metryki: unknown;
  tematy: TematPubliczny[];
  raport_md: Partial<Record<JezykRaportu, string>>;
  status: 'szkic' | 'opublikowana';
  demo: boolean;
  wersja_definicji: string;
  opublikowano: Date | null;
  utworzono: Date;
}

/** What leaves the city: aggregates only, no descriptions or timestamps. */
export interface TematPubliczny {
  tytul: string;
  kategoria: Kategoria;
  miejsce: string;
  dzielnica: string | null;
  liczba_zgloszen: number;
  priorytet: Priorytet;
  status: StatusTematu;
  wynik: number;
  grupy: string[];
  jezyki: string[];
}

export interface Kontekst {
  conversation_id: string;
  cel_podrozy: string | null;
  typ_uzytkownika: string | null;
  jezyk: string | null;
  ostatni_krok: string | null;
  podsumowanie: string | null;
  czy_dotarl: boolean | null;
}

export interface IngestRun {
  _id: ObjectId;
  start: Date;
  koniec: Date | null;
  status: 'trwa' | 'ok' | 'blad';
  statystyki: Record<string, number>;
  bledy: string[];
}

export const WERSJA_DEFINICJI = '1';

/** Corpus name of the hubMI / ROPS knowledge in the generic RAG store. */
export const CORPUS = 'halohub';
