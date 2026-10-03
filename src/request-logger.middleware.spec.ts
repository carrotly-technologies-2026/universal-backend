import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './app.module.js';

describe('RequestLoggerMiddleware', () => {
  it('logs matched and unmatched requests with client details', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    await request(app.getHttpServer()).get('/').set('User-Agent', 'test-agent');
    await request(app.getHttpServer()).post('/missing?x=1').send({ a: 1 });
    await app.close();

    const entries = log.mock.calls
      .map(([message]) => message as string)
      .filter((message) => message.startsWith('{'))
      .map((message) => JSON.parse(message));

    expect(entries).toEqual([
      expect.objectContaining({
        method: 'GET',
        url: '/',
        status: 200,
        completed: true,
        userAgent: 'test-agent',
        ip: expect.any(String),
      }),
      expect.objectContaining({
        method: 'POST',
        url: '/missing?x=1',
        status: 404,
      }),
    ]);
    log.mockRestore();
  });
});
