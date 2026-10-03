import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { RequestLogModule } from './request-log/request-log.module.js';

@Module({
  imports: [RequestLogModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
