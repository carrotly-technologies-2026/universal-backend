import { createHmac } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dynamicVariables } from './context.service.js';
import {
  jezyk,
  parseBariery,
  parsePostCall,
  parsePotrzeby,
  verifySignature,
} from './elevenlabs.js';
import { parseRobots } from './ingest/fetcher.js';
import { documentLinks, entryLinks, parseEntry } from './ingest/parse.js';
import { computeMetrics } from './metrics.js';
import { BarieraDoTematu, normalizujMiejsce, wyliczTematy } from './priority.js';
import { flattenMetrics } from './public.controller.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function bariera(over: Partial<BarieraDoTematu> = {}): BarieraDoTematu {
  return {
    kategoria: 'AWARIA',
    miejsce: 'Dworzec Główny, hala',
    dzielnica: 'Stare Miasto',
    powaga: 2,
    dotyczy: [],
    jezyk: 'pl',
    typ_uzytkownika: 'inny',
    telefon_hash: null,
    rozmowa_id: new ObjectId(),
    demo: false,
    utworzono: daysAgo(1),
    ...over,
  };
}

describe('ElevenLabs webhooks', () => {
  const secret = 'wsec_test';
  const body = Buffer.from('{"type":"post_call_transcription"}');
  const sign = (t: number) =>
    `t=${t},v0=${createHmac('sha256', secret).update(`${t}.${body.toString()}`).digest('hex')}`;

  it('verifies the HMAC signature and rejects stale or forged ones', () => {
    const t = Math.floor(NOW.getTime() / 1000);
    expect(verifySignature(sign(t), body, secret, NOW.getTime())).toBe(true);
    expect(verifySignature(sign(t - 3600), body, secret, NOW.getTime())).toBe(false);
    expect(verifySignature(sign(t), Buffer.from('{}'), secret, NOW.getTime())).toBe(false);
    expect(verifySignature(undefined, body, secret)).toBe(false);
  });

  it('parses a post-call payload', () => {
    const call = parsePostCall({
      type: 'post_call_transcription',
      data: {
        conversation_id: 'conv_1',
        transcript: [{ role: 'agent', message: 'Cześć' }],
        metadata: { call_duration_secs: 125, start_time_unix_secs: 1_790_000_000 },
        conversation_initiation_client_data: {
          dynamic_variables: { system__caller_id: '+48600100200', czy_powrot: 'tak' },
        },
        analysis: { data_collection_results: { jezyk_rozmowy: { value: 'pl-PL' } } },
      },
    })!;
    expect(call.conversationId).toBe('conv_1');
    expect(call.callerId).toBe('+48600100200');
    expect(call.czasTrwaniaS).toBe(125);
    expect(call.czyPowrot).toBe(true);
    expect(jezyk(call.pola.jezyk_rozmowy)).toBe('pl');
    expect(parsePostCall({ type: 'post_call_audio', data: {} })).toBeNull();
    // The agent judged the call a new matter although a context was offered.
    const fresh = parsePostCall({
      type: 'post_call_transcription',
      data: {
        conversation_id: 'conv_2',
        conversation_initiation_client_data: { dynamic_variables: { czy_powrot: 'tak' } },
        analysis: { data_collection_results: { kontynuacja: { value: false } } },
      },
    })!;
    expect(fresh.czyPowrot).toBe(false);
  });

  it('validates barriers and needs from the LLM extraction', () => {
    const bariery = parseBariery(
      JSON.stringify([
        { kategoria: 'AWARIA', opis: 'Winda', miejsce: 'Dworzec', powaga: 3, dotyczy: ['wozek', 'kosmita'] },
        { kategoria: 'NIEZNANA', opis: 'Coś', miejsce: 'Rynek', powaga: 9 },
        { kategoria: 'AWARIA' },
      ]),
    );
    expect(bariery).toHaveLength(2);
    expect(bariery[0]).toMatchObject({ powaga: 3, dotyczy: ['wozek', 'inny'] });
    expect(bariery[1]).toMatchObject({ kategoria: 'INNE', powaga: 1 });
    expect(parseBariery('not json')).toEqual([]);
    expect(parsePotrzeby('[{"temat":"wózek","grupa":"wozek","czy_znaleziono":true}]')).toEqual([
      { temat: 'wózek', grupa: 'wozek', czy_znaleziono: true },
    ]);
  });

  it('builds the return-call greeting variables', () => {
    expect(dynamicVariables(null)).toEqual({ czy_powrot: 'nie', poprzedni_kontekst: '' });
    expect(
      dynamicVariables({
        conversation_id: 'c',
        cel_podrozy: 'HackYeah',
        typ_uzytkownika: 'bagaz',
        jezyk: 'pl',
        ostatni_krok: 'Rondo Mogilskie',
        podsumowanie: 'Jedzie na HackYeah.',
        czy_dotarl: false,
      }),
    ).toEqual({
      czy_powrot: 'tak',
      poprzedni_kontekst: 'Cel: HackYeah. Jedzie na HackYeah. Ostatni krok: Rondo Mogilskie.',
    });
  });
});

describe('topic priority', () => {
  it('normalizes places', () => {
    expect(normalizujMiejsce('ul. Łąkowa  12')).toBe('lakowa 12');
    expect(normalizujMiejsce('Dworzec Główny, hala')).toBe('dworzec glowny hala');
  });

  it('groups by category + place and scores per PLAN 8.6', () => {
    const tematy = wyliczTematy(
      [
        bariera({ powaga: 3, dotyczy: ['wozek'], telefon_hash: 'a' }),
        bariera({ powaga: 3, miejsce: 'dworzec główny hala', telefon_hash: 'b', jezyk: 'uk' }),
        bariera({ kategoria: 'OZNAKOWANIE', powaga: 1 }),
        bariera({ utworzono: daysAgo(40) }), // outside the 30-day window
      ],
      NOW,
    );
    expect(tematy).toHaveLength(2);
    const awaria = tematy.find((t) => t.kategoria === 'AWARIA')!;
    expect(awaria.liczba_zgloszen).toBe(2);
    // (4×1.5 + 4×1) × trend 2 (nothing in the previous week) × 1.2 (2 languages)
    expect(awaria.wynik).toBe(24);
    expect(awaria.priorytet).toBe('P1');
    expect(awaria.jezyki.sort()).toEqual(['pl', 'uk']);
    expect(awaria.rozbicie).toContain('2 zgłoszenia');
    expect(tematy.find((t) => t.kategoria === 'OZNAKOWANIE')!.priorytet).toBe('P3');
  });

  it('gives P1 for severity 3 from two people even with a low score', () => {
    const old = { powaga: 3 as const, utworzono: daysAgo(20) };
    const [t] = wyliczTematy(
      [bariera({ ...old, telefon_hash: 'a' }), bariera({ ...old, telefon_hash: 'b' })],
      NOW,
    );
    expect(t.wynik).toBeLessThan(12);
    expect(t.priorytet).toBe('P1');
  });
});

describe('metrics', () => {
  it('computes rates, gaps and per-day series', () => {
    const r = (over: object) => ({
      jezyk: 'pl',
      typ_uzytkownika: 'senior',
      cel_podrozy: 'HackYeah',
      czy_dotarl: true,
      czas_trwania_s: 100,
      czy_powrot: false,
      demo: false,
      utworzono: daysAgo(1),
      ...over,
    });
    const m = computeMetrics({
      od: daysAgo(7),
      do: NOW,
      jezyk: null,
      rozmowy: [
        r({}),
        r({ czas_trwania_s: 300, czy_powrot: true }),
        r({ jezyk: 'uk', czy_dotarl: false }),
        r({ jezyk: 'en', cel_podrozy: null, czy_dotarl: null }),
      ],
      bariery: [
        { kategoria: 'JEZYK', dzielnica: null, powaga: 2, jezyk: 'uk', typ_uzytkownika: 'obcokrajowiec', dotyczy: [], demo: true, utworzono: daysAgo(2) },
      ],
      zapytania: [
        { grupa: 'wozek', jezyk: 'pl', liczba_wynikow: 0, demo: false },
        { grupa: 'wozek', jezyk: 'pl', liczba_wynikow: 2, demo: false },
      ],
      tematy: [],
    });
    expect(m.rozmowy.razem).toBe(4);
    expect(m.mediana_czasu_s.razem).toBe(100);
    expect(m.odsetek_dotarlo.razem).toBeCloseTo(2 / 3, 3);
    expect(m.luka_jezykowa_dotarcia).toBe(100);
    expect(m.ponowne_telefony.razem).toBe(0.25);
    expect(m.bariery_jezykowe.wg_jezyka).toEqual({ uk: 1 });
    expect(m.bariery.wg_dzielnicy).toEqual({ nieznany: 1 });
    expect(m.odsetek_bez_wynikow.razem).toBe(0.5);
    expect(m.demo).toBe(true);
    expect(m.rozmowy.wg_dnia).toHaveLength(8);
    expect(m.rozmowy.wg_dnia.reduce((n, d) => n + d.liczba, 0)).toBe(4);
    const csvRows = flattenMetrics(m);
    expect(csvRows).toContainEqual(['rozmowy', 'wg_jezyka', 'uk', 1]);
    expect(csvRows).toContainEqual(['luka_jezykowa_dotarcia', '', '', 100]);
  });
});

describe('ROPS parsing', () => {
  const fixture = (f: string) => readFileSync(join(import.meta.dirname, 'ingest/__fixtures__', f), 'utf8');
  const base = 'https://rops.krakow.pl/innowacje-spoleczne/biblioteka-innowacji-spolecznych/dla-seniorow';

  it('finds entry links only in the main column', () => {
    const links = entryLinks(fixture('category.html'), base, 'dla-seniorow');
    expect(links.length).toBeGreaterThanOrEqual(15);
    expect(links).toContain(`${base},kody-qr-na-pomoc-seniorom`);
    expect(links.some((l) => l.endsWith('from-menu'))).toBe(false);
  });

  it('extracts the entry text without menus or icon tables', () => {
    const e = parseEntry(fixture('entry.html'), `${base},kody-qr-na-pomoc-seniorom`)!;
    expect(e.title).toBe('Kody QR na pomoc seniorom');
    expect(e.text).toContain('Na czym polega rozwiązanie?');
    expect(e.text).toContain('unikalnych kodów QR');
    expect(e.text).not.toContain('Ogromne menu');
    expect(e.text).not.toContain('pobierz');
    expect(e.contact).toBe('Autorzy: Fundacja Internationaler Bund Polska');
    expect(documentLinks(fixture('entry.html'), base).every((l) => !/Zasady/.test(l.url))).toBe(true);
  });

  it('reads robots.txt rules for us', () => {
    expect(parseRobots('User-agent: *\nDisallow: /admin\n\nUser-agent: Other\nDisallow: /')).toEqual(['/admin']);
  });
});

describe('extractive summary', () => {
  it('skips question headings', async () => {
    const { extractiveSummary } = await import('./ingest/parse.js');
    expect(
      extractiveSummary('1. Na czym polega rozwiązanie?\n\nInnowacja dostarcza seniorom naklejki z kodami QR na ubrania. Po zeskanowaniu widać dane kontaktowe. Trzecie zdanie.'),
    ).toBe('Innowacja dostarcza seniorom naklejki z kodami QR na ubrania. Po zeskanowaniu widać dane kontaktowe.');
  });
});
