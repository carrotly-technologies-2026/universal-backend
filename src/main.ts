import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Coolify's proxy reaches the app over the private Docker network; trusting only
  // private addresses makes req.ip the real client IP without letting public
  // clients spoof it via X-Forwarded-For.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
