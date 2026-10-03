import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // rawBody: webhook signatures (ElevenLabs HMAC) are computed over the exact bytes.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  // Post-call webhooks carry the whole transcript.
  app.useBodyParser('json', { limit: '5mb' });
  // Coolify's proxy reaches the app over the private Docker network; trusting only
  // private addresses makes req.ip the real client IP without letting public
  // clients spoof it via X-Forwarded-For.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  // The dApp frontend is served from another origin; there are no cookies or
  // credentials to protect, so any origin may call the API.
  app.enableCors();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
