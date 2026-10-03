import { Global, Module } from '@nestjs/common';
import { GeminiService } from './gemini.service.js';

@Global()
@Module({
  providers: [GeminiService],
  exports: [GeminiService],
})
export class LlmModule {}
