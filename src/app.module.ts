import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { EscrowModule } from './escrow/escrow.module.js';
import { RequestLogModule } from './request-log/request-log.module.js';

@Module({
  imports: [RequestLogModule, EscrowModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
