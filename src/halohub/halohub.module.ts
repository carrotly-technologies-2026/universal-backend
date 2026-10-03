import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module.js';
import { PlacesModule } from '../places/places.module.js';
import { TransitModule } from '../transit/transit.module.js';
import { ContextService } from './context.service.js';
import { ConversationService } from './conversation.service.js';
import { DemoService } from './demo.service.js';
import { HalohubStore } from './halohub.store.js';
import { IdeasService } from './ideas.service.js';
import { IngestService } from './ingest/ingest.service.js';
import { KnowledgeService } from './knowledge.service.js';
import { MetricsService } from './metrics.service.js';
import { PipelineService } from './pipeline.service.js';
import { JobsController, PanelController } from './panel.controller.js';
import { PublicController } from './public.controller.js';
import { ReportService } from './report.service.js';
import { RopsController } from './rops.controller.js';
import { RopsService } from './rops.service.js';
import { SchedulerService } from './scheduler.service.js';
import { TelephonyController } from './telephony.controller.js';
import { TopicsService } from './topics.service.js';

/**
 * "Halo, Hub!" – voice guide for Kraków (polish-stonks-bot/PLAN.md).
 * Domain module on top of the generic Database, LLM and RAG modules; all
 * routes live under /halohub.
 */
@Module({
  imports: [RagModule, TransitModule, PlacesModule],
  controllers: [TelephonyController, PanelController, JobsController, PublicController, RopsController],
  providers: [
    HalohubStore,
    ContextService,
    ConversationService,
    KnowledgeService,
    TopicsService,
    MetricsService,
    ReportService,
    IngestService,
    DemoService,
    SchedulerService,
    PipelineService,
    RopsService,
    IdeasService,
  ],
  exports: [IngestService, TopicsService, ReportService, DemoService],
})
export class HalohubModule {}
