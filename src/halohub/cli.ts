import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { DemoService } from './demo.service.js';
import { HalohubModule } from './halohub.module.js';
import { IngestService } from './ingest/ingest.service.js';
import { ReportService } from './report.service.js';
import { TopicsService } from './topics.service.js';

@Module({ imports: [DatabaseModule, LlmModule, HalohubModule] })
class CliModule {}

const USAGE = `Usage: node dist/halohub/cli.js <command>
  ingest [zrodlo...] [--limit N]   crawl hubMI/ROPS into the RAG store
  topics                           recompute topics and priorities
  report                           generate the daily report + publication draft
  seed [days] [conversations]      insert demo data (demo = true)
  unseed                           delete demo data`;

const [command, ...args] = process.argv.slice(2);
const app = await NestFactory.createApplicationContext(CliModule, {
  logger: ['log', 'warn', 'error'],
});
try {
  let result: unknown;
  switch (command) {
    case 'ingest': {
      const i = args.indexOf('--limit');
      const limit = i >= 0 ? Number(args.splice(i, 2)[1]) : undefined;
      result = await app.get(IngestService).run({ zrodla: args, limit });
      break;
    }
    case 'topics':
      result = await app.get(TopicsService).recompute();
      break;
    case 'report':
      result = await app.get(ReportService).generateDaily();
      break;
    case 'seed':
      result = await app.get(DemoService).seed(Number(args[0]) || 14, Number(args[1]) || 120);
      break;
    case 'unseed':
      result = await app.get(DemoService).clear();
      break;
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} finally {
  await app.close();
}
