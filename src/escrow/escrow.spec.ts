import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { detailsHash } from './details.js';
import { EscrowAccount } from './escrow-account.js';
import { EscrowModule } from './escrow.module.js';
import { SolanaService } from './solana.service.js';
import { WaybillValidator } from './waybill-validator.service.js';

const ADDRESS = '11111111111111111111111111111111';
const DETAILS = {
  itemTitle: 'Rower szosowy',
  recipientName: 'Jan Kowalski',
  recipientAddress: 'ul. Długa 1, 00-001 Warszawa',
};
const PDF = Buffer.from('%PDF-1.7\nfake waybill');
const VALIDATION = {
  verdict: 'valid',
  carrier: 'InPost',
  trackingNumber: '123',
  recipientName: 'Jan Kowalski',
  recipientAddress: 'ul. Długa 1, 00-001 Warszawa',
  shipDate: '2026-10-01',
  reasons: ['Wszystko się zgadza.'],
};

describe('Escrow API', () => {
  let app: INestApplication;
  let dataDir: string;
  let escrow: Partial<EscrowAccount> | null;
  const getEscrow = vi.fn(async () => escrow);
  const validate = vi.fn(async () => VALIDATION);

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'escrow-'));
    process.env.DATA_DIR = dataDir;
    escrow = {
      status: 0,
      statusName: 'Funded',
      createdAt: 1_700_000_000,
      detailsHash: detailsHash(DETAILS),
      waybillHash: '00'.repeat(32),
    };
    getEscrow.mockClear();
    validate.mockClear();
    const moduleRef = await Test.createTestingModule({
      imports: [EscrowModule],
    })
      .overrideProvider(SolanaService)
      .useValue({ getEscrow })
      .overrideProvider(WaybillValidator)
      .useValue({ validate })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('accepts details only when their hash matches the chain', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post(`/escrows/${ADDRESS}/details`)
      .send({ ...DETAILS, recipientName: 'Ktoś Inny' })
      .expect(400);
    await request(server)
      .post(`/escrows/${ADDRESS}/details`)
      .send({ ...DETAILS, itemTitle: `  ${DETAILS.itemTitle} ` })
      .expect(201, DETAILS);

    const res = await request(server).get(`/escrows/${ADDRESS}`).expect(200);
    expect(res.body.details).toEqual(DETAILS);
  });

  it('rejects malformed addresses and unknown escrows', async () => {
    const server = app.getHttpServer();
    await request(server).get('/escrows/not-a-key').expect(400);
    escrow = null;
    await request(server).get(`/escrows/${ADDRESS}`).expect(404);
  });

  it('stores a waybill, validates it once and serves it back', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post(`/escrows/${ADDRESS}/details`)
      .send(DETAILS)
      .expect(201);
    const upload = () =>
      request(server)
        .post(`/escrows/${ADDRESS}/waybills`)
        // The client-declared type is ignored in favor of the magic bytes.
        .attach('file', PDF, {
          filename: 'list.pdf',
          contentType: 'image/png',
        })
        .expect(201);

    const first = await upload();
    expect(first.body.validation).toEqual(VALIDATION);
    expect(first.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(validate).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: 'application/pdf',
        details: DETAILS,
        escrowCreatedAt: 1_700_000_000,
      }),
    );
    expect((await upload()).body).toEqual(first.body);
    expect(validate).toHaveBeenCalledTimes(1);

    escrow!.waybillHash = first.body.hash;
    const shown = await request(server).get(`/escrows/${ADDRESS}`).expect(200);
    expect(shown.body.waybills).toEqual([
      expect.objectContaining({
        hash: first.body.hash,
        mimeType: 'application/pdf',
        size: PDF.length,
        committedOnChain: true,
      }),
    ]);

    const file = await request(server)
      .get(`/escrows/${ADDRESS}/waybills/${first.body.hash}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200)
      .expect('Content-Type', 'application/pdf');
    expect(file.body).toEqual(PDF);
    await request(server)
      .get(`/escrows/${ADDRESS}/waybills/${'0'.repeat(64)}`)
      .expect(404);
  });

  it('rejects files that are not PDF/JPEG/PNG by their bytes', async () => {
    await request(app.getHttpServer())
      .post(`/escrows/${ADDRESS}/waybills`)
      .attach('file', Buffer.from('GIF89a...'), {
        filename: 'list.pdf',
        contentType: 'application/pdf',
      })
      .expect(415);
    expect(validate).not.toHaveBeenCalled();
  });

  it('refuses waybills once the escrow is no longer Funded', async () => {
    escrow = { ...escrow, status: 1, statusName: 'Shipped' };
    await request(app.getHttpServer())
      .post(`/escrows/${ADDRESS}/waybills`)
      .attach('file', PDF, 'list.pdf')
      .expect(409);
    expect(validate).not.toHaveBeenCalled();
  });
});
