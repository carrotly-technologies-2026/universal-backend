import { Injectable } from '@nestjs/common';
import { ConversationService } from './conversation.service.js';
import { HalohubStore } from './halohub.store.js';
import { Kategoria, Zapytanie } from './model.js';
import { TopicsService } from './topics.service.js';

const MIEJSCA: [string, string][] = [
  ['Dworzec Główny, hala', 'Stare Miasto'],
  ['Dworzec Główny, peron 4', 'Stare Miasto'],
  ['Rondo Mogilskie, przystanek', 'Grzegórzki'],
  ['TAURON Arena, wejście główne', 'Czyżyny'],
  ['Galeria Krakowska, przejście podziemne', 'Stare Miasto'],
  ['Plac Centralny', 'Nowa Huta'],
  ['Rondo Grunwaldzkie', 'Dębniki'],
  ['Rynek Podgórski', 'Podgórze'],
  ['Teatr Bagatela, przystanek', 'Stare Miasto'],
  ['Szpital Uniwersytecki, Prokocim', 'Prokocim-Bieżanów'],
];

const PROBLEMY: [Kategoria, string, 1 | 2 | 3][] = [
  ['AWARIA', 'Nie działała winda z hali na peron', 3],
  ['BARIERA_FIZYCZNA', 'Schody bez windy i bez rampy', 3],
  ['BARIERA_FIZYCZNA', 'Wysoki krawężnik przy przejściu', 2],
  ['OZNAKOWANIE', 'Brak tablic kierujących do tramwaju', 2],
  ['KOMUNIKACJA_MIEJSKA', 'Tramwaj z wysoką podłogą, nie dało się wsiąść', 3],
  ['KOMUNIKACJA_MIEJSKA', 'Biletomat nie przyjmował karty', 1],
  ['JEZYK', 'Brak informacji po angielsku i ukraińsku', 2],
  ['ODPOCZYNEK_I_TOALETY', 'Brak ławek po drodze', 1],
  ['ORIENTACJA', 'Mylący układ przejść, rozmówca się zgubił', 2],
  ['BEZPIECZENSTWO', 'Ciemne przejście wieczorem', 2],
];

const PYTANIA: [string, string, boolean][] = [
  ['sprzęt ułatwiający poruszanie się na wózku', 'wozek', true],
  ['pomoc dla seniora z demencją, który się gubi', 'senior', true],
  ['wsparcie dla cudzoziemców w załatwianiu spraw', 'obcokrajowiec', true],
  ['wypożyczalnia chodzików w Krakowie', 'chodzik', false],
  ['opieka nad dzieckiem podczas wizyty w urzędzie', 'wozek_dzieciecy', false],
  ['tłumacz języka migowego na dworcu', 'inny', false],
];

const CELE = ['HackYeah', 'szpital', 'rodzina', 'urząd', 'dworzec', 'lotnisko'];
const TYPY = ['senior', 'wozek', 'chodzik', 'bagaz', 'obcokrajowiec', 'nowy_w_miescie', 'wozek_dzieciecy', 'inny'];

/** Deterministic PRNG (mulberry32) so demo data is the same every time. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sample data flagged `demo = true` ("dane przykładowe", PLAN.md 9.6). */
@Injectable()
export class DemoService {
  constructor(
    private readonly conversations: ConversationService,
    private readonly store: HalohubStore,
    private readonly topics: TopicsService,
  ) {}

  async seed(dni = 14, ile = 120, now = new Date()) {
    await this.clear(false);
    const r = rng(2026);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
    let bariery = 0;
    const zapytania: Omit<Zapytanie, '_id'>[] = [];

    for (let i = 0; i < ile; i++) {
      // More calls recently, so the 7-day trend is visible.
      const ageMs = Math.pow(r(), 1.6) * dni * 86_400_000;
      const kiedy = new Date(now.getTime() - ageMs);
      const jezyk = r() < 0.7 ? 'pl' : r() < 0.5 ? 'uk' : 'en';
      const typ = jezyk === 'pl' ? pick(TYPY) : r() < 0.6 ? 'obcokrajowiec' : pick(TYPY);
      const problemy = Array.from({ length: r() < 0.55 ? (r() < 0.3 ? 2 : 1) : 0 }, () => {
        // Hot spots get most reports so some topics reach P1.
        const [miejsce, dzielnica] = r() < 0.5 ? MIEJSCA[Math.floor(r() * 3)] : pick(MIEJSCA);
        const [kategoria, opis, powaga] =
          jezyk !== 'pl' && r() < 0.4 ? PROBLEMY[6] : pick(PROBLEMY);
        return { kategoria, opis, miejsce, dzielnica, powaga, dotyczy: [typ] };
      });
      const potrzeby = r() < 0.3 ? [pick(PYTANIA)] : [];
      const conversationId = `demo_${i}`;
      const res = await this.conversations.savePostCall(
        {
          conversationId,
          callerId: `+48600${String(Math.floor(r() * 90) + 10).padStart(6, '0')}`,
          czasTrwaniaS: Math.round(90 + r() * 420),
          rozpoczeto: kiedy,
          czyPowrot: r() < 0.12,
          transkrypcja: [],
          pola: {
            typ_uzytkownika: typ,
            jezyk_rozmowy: jezyk,
            cel_podrozy: pick(CELE),
            czy_dotarl: r() < (jezyk === 'pl' ? 0.82 : 0.64),
            problemy_json: JSON.stringify(problemy),
            potrzeby_json: JSON.stringify(
              potrzeby.map(([temat, grupa, ok]) => ({ temat, grupa, czy_znaleziono: ok })),
            ),
          },
        },
        true,
      );
      bariery += res.bariery;
      for (const [pytanie, grupa, ok] of potrzeby) {
        zapytania.push({
          conversation_id: conversationId,
          pytanie,
          grupa,
          jezyk,
          liczba_wynikow: ok ? 1 + Math.floor(r() * 3) : 0,
          top_url: ok ? 'https://rops.krakow.pl/innowacje-spoleczne/biblioteka-innowacji-spolecznych/dla-seniorow,kody-qr-na-pomoc-seniorom' : null,
          top_tytul: ok ? 'Kody QR na pomoc seniorom' : null,
          demo: true,
          utworzono: kiedy,
        });
      }
    }
    if (zapytania.length) {
      await (await this.store.zapytania()).insertMany(zapytania as Zapytanie[]);
    }
    await this.topics.recompute(now);
    return { rozmowy: ile, bariery, zapytania: zapytania.length };
  }

  async clear(recompute = true) {
    const demo = { demo: true };
    const [rozmowy, bariery, zapytania, tematy] = await Promise.all([
      this.store.rozmowy().then((c) => c.deleteMany(demo)),
      this.store.bariery().then((c) => c.deleteMany(demo)),
      this.store.zapytania().then((c) => c.deleteMany(demo)),
      this.store.tematy().then((c) => c.deleteMany(demo)),
    ]);
    if (recompute) await this.topics.recompute();
    return {
      rozmowy: rozmowy.deletedCount,
      bariery: bariery.deletedCount,
      zapytania: zapytania.deletedCount,
      tematy: tematy.deletedCount,
    };
  }
}
