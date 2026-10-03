import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { EscrowModule } from './escrow/escrow.module.js';
import { HalohubModule } from './halohub/halohub.module.js';
import { LlmModule } from './llm/llm.module.js';
import { RagModule } from './rag/rag.module.js';
import { RequestLogModule } from './request-log/request-log.module.js';

@Module({
  imports: [
    // Shared infrastructure
    DatabaseModule,
    LlmModule,
    RequestLogModule,
    // Generic features
    RagModule,
    // Domains
    EscrowModule,
    HalohubModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
