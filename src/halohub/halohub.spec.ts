import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { DatabaseModule } from '../database/database.module.js';
import { MongoService } from '../database/mongo.service.js';
import { LlmModule } from '../llm/llm.module.js';
import { RagModule } from '../rag/rag.module.js';
import { HalohubModule } from './halohub.module.js';

const ENV = {
  MONGODB_DB: 'halohub_test',
  ELEVENLABS_WEBHOOK_SECRET: 'wsec',
  HALOHUB_INIT_SECRET: 'init',
  HALOHUB_TOOL_SECRET: 'tool',
  HALOHUB_ADMIN_TOKEN: 'admin',
  HALOHUB_CRON_SECRET: 'cron',
  RAG_API_KEY: 'rag',
  PHONE_HASH_SALT: 'salt',
  PUBLIC_MIN_ZGLOSZEN: '2',
  GEMINI_API_KEY: '',
};

function postCall(id: string, caller: string, problemy: object[], extra: object = {}) {
  return {
    type: 'post_call_transcription',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      conversation_id: id,
      transcript: [{ role: 'user', message: 'Winda nie działa' }],
      metadata: { call_duration_secs: 180, start_time_unix_secs: Math.floor(Date.now() / 1000) - 60 },
      conversation_initiation_client_data: { dynamic_variables: { system__caller_id: caller } },
      analysis: {
        data_collection_results: {
          typ_uzytkownika: { value: 'wozek' },
          jezyk_rozmowy: { value: 'pl' },
          cel_podrozy: { value: 'HackYeah' },
          czy_dotarl: { value: true },
          kontekst_podsumowanie: { value: 'Jedzie z Dworca na HackYeah na wózku.' },
          ostatni_krok: { value: 'Rondo Mogilskie' },
          problemy_json: { value: JSON.stringify(problemy) },
          potrzeby_json: { value: '[{"temat":"wypożyczalnia wózków","grupa":"wozek","czy_znaleziono":false}]' },
          ...extra,
        },
      },
    },
  };
}

const sign = (raw: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v0=${createHmac('sha256', ENV.ELEVENLABS_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex')}`;
};

describe('Halo, Hub! API (MongoDB)', () => {
  let mongod: MongoMemoryServer;
  let app: INestApplication;
  const saved = { ...process.env };

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    Object.assign(process.env, ENV, { MONGODB_URI: mongod.getUri() });
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, LlmModule, RagModule, HalohubModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.get(MongoService).db().then((db) => db.dropDatabase());
    await app?.close();
    await mongod?.stop();
    process.env = saved;
  });

  const server = () => app.getHttpServer();
  const admin = { Authorization: 'Bearer admin' };

  it('stores a signed post-call webhook and continues the route on a return call', async () => {
    const barrier = { kategoria: 'AWARIA', opis: 'Nie działała winda', miejsce: 'Dworzec Główny, hala', dzielnica: 'Stare Miasto', powaga: 3, dotyczy: ['wozek'] };
    for (const [id, caller] of [['c1', '+48600100200'], ['c2', '+48600300400']]) {
      const raw = JSON.stringify(postCall(id, caller, [barrier]));
      await request(server())
        .post('/halohub/webhooks/elevenlabs')
        .set('Content-Type', 'application/json')
        .set('ElevenLabs-Signature', sign(raw))
        .send(raw)
        .expect(200, { ok: true, bariery: 1 });
    }
    // Retried delivery replaces, not duplicates.
    const raw = JSON.stringify(postCall('c1', '+48600100200', [barrier]));
    await request(server()).post('/halohub/webhooks/elevenlabs').set('Content-Type', 'application/json').set('ElevenLabs-Signature', sign(raw)).send(raw).expect(200);
    await request(server()).post('/halohub/webhooks/elevenlabs').set('Content-Type', 'application/json').set('ElevenLabs-Signature', 't=1,v0=bad').send(raw).expect(401);

    const init = await request(server())
      .post('/halohub/webhooks/elevenlabs/init')
      .set('x-init-secret', 'init')
      .send({ caller_id: '+48600100200', agent_id: 'a', called_number: '+420910923449', call_sid: 'CA1' })
      .expect(200);
    expect(init.body).toEqual({
      type: 'conversation_initiation_client_data',
      dynamic_variables: {
        czy_powrot: 'tak',
        poprzedni_kontekst: 'Jedzie z Dworca na HackYeah na wózku. Ostatni krok: Rondo Mogilskie. Trasa zakończona.',
      },
    });
    const unknown = await request(server()).post('/halohub/webhooks/elevenlabs/init?key=init').send({ caller_id: '+48999' }).expect(200);
    expect(unknown.body.dynamic_variables.czy_powrot).toBe('nie');
    await request(server()).post('/halohub/webhooks/elevenlabs/init').send({ caller_id: '+48600100200' }).expect(401);
  });

  it('answers szukaj_wiedzy from the RAG store (text search without an embedding key)', async () => {
    await request(server())
      .post('/rag/halohub/documents')
      .set('x-api-key', 'rag')
      .send({
        documents: [
          { url: 'https://rops.krakow.pl/x,wozki', title: 'Wypożyczalnia sprzętu rehabilitacyjnego', text: 'Bezpłatne wypożyczanie wózków inwalidzkich i chodzików dla mieszkańców.', source: 'biblioteka', tags: ['wozek', 'chodzik'], summary: 'Możesz bezpłatnie wypożyczyć wózek. Zadzwoń do punktu.', contact: 'tel. 12 000 00 00' },
          { url: 'https://rops.krakow.pl/x,seniorzy', title: 'Kody QR dla seniorów', text: 'Naklejki z kodami QR pomagają seniorom z demencją.', source: 'biblioteka', tags: ['senior'] },
        ],
      })
      .expect(201, { created: 2, updated: 0, unchanged: 0, embeddedChunks: 0 });

    const res = await request(server())
      .post('/halohub/tools/szukaj_wiedzy')
      .set('x-tool-secret', 'tool')
      .send({ pytanie: 'wypożyczanie wózków', grupa: 'wozek', conversation_id: 'c1' })
      .expect(200);
    expect(res.body.wyniki).toHaveLength(1);
    expect(res.body.wyniki[0]).toMatchObject({
      tytul: 'Wypożyczalnia sprzętu rehabilitacyjnego',
      glos_streszczenie: 'Możesz bezpłatnie wypożyczyć wózek. Zadzwoń do punktu.',
      zrodlo: 'Biblioteka Innowacji Społecznych ROPS w Krakowie',
    });
    const none = await request(server()).post('/halohub/tools/szukaj_wiedzy').set('x-tool-secret', 'tool').send({ pytanie: 'zupełnie nic takiego', grupa: 'senior' }).expect(200);
    expect(none.body).toMatchObject({ wyniki: [], komunikat: expect.stringContaining('12 422 06 36') });
    await request(server()).post('/halohub/tools/szukaj_wiedzy').send({ pytanie: 'x' }).expect(401);
  });

  it('builds topics, metrics, a report and publishes open data', async () => {
    await request(server()).post('/halohub/jobs/tematy').set('x-cron-secret', 'cron').expect(200);
    const tematy = (await request(server()).get('/halohub/api/tematy').set(admin).expect(200)).body;
    expect(tematy).toHaveLength(1);
    expect(tematy[0]).toMatchObject({ kategoria: 'AWARIA', liczba_zgloszen: 2, liczba_osob: 2, priorytet: 'P1', status: 'nowy' });

    const detail = (await request(server()).get(`/halohub/api/tematy/${tematy[0].id}`).set(admin).expect(200)).body;
    expect(detail.bariery).toHaveLength(2);
    const patched = (await request(server()).patch(`/halohub/api/tematy/${tematy[0].id}`).set(admin).send({ status: 'zaplanowany', notatka: 'Serwis windy' }).expect(200)).body;
    expect(patched).toMatchObject({ status: 'zaplanowany', notatka: 'Serwis windy' });
    expect(patched.historia).toHaveLength(1);

    const m = (await request(server()).get('/halohub/api/metryki').set(admin).expect(200)).body;
    expect(m).toMatchObject({ rozmowy: { razem: 2 }, bariery: { razem: 2 }, odsetek_dotarlo: { razem: 1 }, pytania_rag: { razem: 2 }, odsetek_bez_wynikow: { razem: 0.5 }, czas_reakcji_dni: { razem: 0 } });
    expect(m.tematy_p1.razem).toBe(1);

    const luki = (await request(server()).get('/halohub/api/wiedza/luki').set(admin).expect(200)).body;
    expect(luki.pytania_bez_wynikow[0]).toMatchObject({ pytanie: 'zupełnie nic takiego', liczba: 1 });
    expect(luki.potrzeby_nieznalezione[0]).toMatchObject({ temat: 'wypożyczalnia wózków', liczba: 2 });
    expect(luki.ingest.korpus.documents).toBe(2);

    const rozmowy = (await request(server()).get('/halohub/api/rozmowy').set(admin).expect(200)).body;
    expect(rozmowy[0]).not.toHaveProperty('transkrypcja');
    expect(rozmowy[0].liczba_barier).toBe(1);
    const detail1 = (await request(server()).get(`/halohub/api/rozmowy/${rozmowy.find((r: { conversation_id: string }) => r.conversation_id === 'c1').id}`).set(admin).expect(200)).body;
    expect(detail1).not.toHaveProperty('telefon_hash');
    expect(detail1.transkrypcja).toEqual([{ role: 'user', message: 'Winda nie działa' }]);
    expect(detail1.bariery).toHaveLength(1);
    expect(detail1.zapytania_rag).toHaveLength(1);
    expect(detail1.poprzednie).toEqual([]);
    await request(server()).get('/halohub/api/rozmowy/000000000000000000000000').set(admin).expect(404);

    await request(server()).get('/halohub/public/publikacja').expect(404);
    const job = (await request(server()).post('/halohub/jobs/raport-dzienny').set(admin).expect(200)).body;
    expect(job).toMatchObject({ zrodlo: 'szablon', status: 'szkic' });
    const raport = (await request(server()).get('/halohub/api/raporty/najnowszy?lang=pl').set(admin).expect(200)).body;
    expect(raport.tresc_md).toContain('Dworzec Główny, hala');

    await request(server()).post(`/halohub/api/publikacje/${job.publikacja_id}/opublikuj`).set(admin).expect(200);
    await request(server()).post(`/halohub/api/publikacje/${job.publikacja_id}/opublikuj`).set(admin).expect(409);
    const pub = (await request(server()).get('/halohub/public/publikacja?lang=en').expect(200)).body;
    expect(pub).toMatchObject({ status: 'opublikowana', liczba_tematow: 1, demo: false, jezyki_raportu: ['pl'] });
    expect(pub.tematy[0]).not.toHaveProperty('rozbicie');
    expect(pub.raport_md).toContain('Raport dzienny');

    const csv = await request(server()).get('/halohub/public/tematy.csv').expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[1]).toContain('P1,"Awaria · Dworzec Główny, hala",AWARIA');
    const json = (await request(server()).get('/halohub/public/metryki.json').expect(200)).body;
    expect(json).toMatchObject({ licencja: 'CC BY 4.0', metryki: { rozmowy: { razem: 2 } } });
  });

  it('reports pipeline stages and refuses webhooks without a phone salt', async () => {
    const p = (await request(server()).get('/halohub/api/pipeline').set(admin).expect(200)).body;
    expect(p.etapy.map((e: { id: string }) => e.id)).toEqual(['ingest', 'embedding', 'rozmowy', 'tematy', 'raport', 'publikacja']);
    const byId = Object.fromEntries(p.etapy.map((e: { id: string }) => [e.id, e]));
    expect(byId.rozmowy.metryki.rozmowy_24h).toBe(2);
    expect(byId.tematy.metryki.p1).toBe(1);
    expect(byId.raport).toMatchObject({ status: 'ostrzezenie', metryki: { zrodlo: 'szablon' } });
    expect(byId.publikacja.metryki.opublikowane).toBe(1);
    expect(byId.embedding.status).toBe('ostrzezenie');

    delete process.env.PHONE_HASH_SALT;
    try {
      await request(server()).post('/halohub/webhooks/elevenlabs/init').set('x-init-secret', 'init').send({ caller_id: '+48600100200' }).expect(503);
    } finally {
      process.env.PHONE_HASH_SALT = ENV.PHONE_HASH_SALT;
    }
  });

  it('protects the panel and seeds demo data', async () => {
    await request(server()).get('/halohub/api/metryki').expect(401);
    await request(server()).get('/halohub/api/metryki').set({ Authorization: 'Bearer nope' }).expect(401);
    const seeded = (await request(server()).post('/halohub/api/demo/seed').set(admin).send({ dni: 14, rozmow: 60 }).expect(201)).body;
    expect(seeded.rozmowy).toBe(60);
    const m = (await request(server()).get('/halohub/api/metryki?jezyk=uk').set(admin).expect(200)).body;
    expect(m.demo).toBe(true);
    expect(Object.keys(m.rozmowy.wg_jezyka)).toEqual(['uk']);
    const tematy = (await request(server()).get('/halohub/api/tematy?priorytet=P1').set(admin).expect(200)).body;
    expect(tematy.length).toBeGreaterThan(0);
    await request(server()).delete('/halohub/api/demo').set(admin).expect(200);
    const after = (await request(server()).get('/halohub/api/metryki').set(admin).expect(200)).body;
    expect(after.rozmowy.razem).toBe(2);
  });

  it('accepts unsigned post-call webhooks when no secret is configured', async () => {
    delete process.env.ELEVENLABS_WEBHOOK_SECRET;
    try {
      await request(server())
        .post('/halohub/webhooks/elevenlabs')
        .send(postCall('unsigned_1', '+48600999000', []))
        .expect(200, { ok: true, bariery: 0 });
    } finally {
      process.env.ELEVENLABS_WEBHOOK_SECRET = ENV.ELEVENLABS_WEBHOOK_SECRET;
    }
  });
});
