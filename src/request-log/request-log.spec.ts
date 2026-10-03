import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { RequestStatsService } from './request-stats.service.js';

describe('Request logging and stats', () => {
  let app: INestApplication;

  beforeEach(async () => {
    process.env.STATS_PASSWORD = 'secret';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    delete process.env.STATS_PASSWORD;
    await app.close();
  });

  it('records matched and unmatched requests', async () => {
    await request(app.getHttpServer()).get('/').set('User-Agent', 'test-agent');
    await request(app.getHttpServer()).post('/missing?x=1');

    const stats = app.get(RequestStatsService);
    expect(stats.total).toBe(2);
    expect([...stats.byRoute.keys()]).toEqual(['GET /', 'POST /missing']);
    expect(stats.byStatus.get(404)).toBe(1);
    expect(stats.recent[0]).toMatchObject({ url: '/missing?x=1', status: 404 });
    expect(stats.recent[1]).toMatchObject({
      userAgent: 'test-agent',
      status: 200,
    });
  });

  it('requires the password and escapes rendered values', async () => {
    const server = app.getHttpServer();
    await request(server)
      .get('/stats')
      .expect(401)
      .expect('WWW-Authenticate', /Basic/);
    await request(server).get('/stats').auth('any', 'wrong').expect(401);

    await request(server)
      .get('/')
      .set('User-Agent', '<script>alert(1)</script>');
    const res = await request(server)
      .get('/stats')
      .auth('any', 'secret')
      .expect(200);
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.text).not.toContain('<script>');
  });

  it('is disabled without STATS_PASSWORD', async () => {
    delete process.env.STATS_PASSWORD;
    await request(app.getHttpServer()).get('/stats').expect(503);
  });
});
