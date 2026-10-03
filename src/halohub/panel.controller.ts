import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { bearer } from '../common/secret.js';
import { SecretGuard } from '../common/secret.guard.js';
import { ConversationService } from './conversation.service.js';
import { DemoService } from './demo.service.js';
import { IngestService } from './ingest/ingest.service.js';
import { MetricsService, parseOkres } from './metrics.service.js';
import { JEZYKI_RAPORTU, JezykRaportu } from './model.js';
import { PipelineService } from './pipeline.service.js';
import { ReportService } from './report.service.js';
import { TopicsService } from './topics.service.js';

const ADMIN = bearer('HALOHUB_ADMIN_TOKEN');

export const lang = (v?: string): JezykRaportu =>
  (JEZYKI_RAPORTU as readonly string[]).includes(v ?? '') ? (v as JezykRaportu) : 'pl';

/** City panel API (logged-in officials). */
@Controller('halohub/api')
@UseGuards(new SecretGuard(ADMIN))
export class PanelController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly topics: TopicsService,
    private readonly reports: ReportService,
    private readonly conversations: ConversationService,
    private readonly demo: DemoService,
    private readonly pipeline: PipelineService,
  ) {}

  @Get('pipeline')
  pipelineStatus() {
    return this.pipeline.status();
  }

  @Get('metryki')
  metryki(@Query('od') od?: string, @Query('do') to?: string, @Query('jezyk') jezyk?: string) {
    return this.metrics.compute(parseOkres(od, to), jezyk || null);
  }

  @Get('tematy')
  tematy(@Query() q: Record<string, string | undefined>) {
    return this.topics.list({
      priorytet: q.priorytet,
      status: q.status,
      kategoria: q.kategoria,
      dzielnica: q.dzielnica,
      jezyk: q.jezyk,
      aktywne: q.aktywne !== 'false',
      limit: q.limit ? Number(q.limit) || 100 : 100,
    });
  }

  @Get('tematy/:id')
  temat(@Param('id') id: string) {
    return this.topics.get(id);
  }

  @Patch('tematy/:id')
  updateTemat(@Param('id') id: string, @Body() body: unknown) {
    return this.topics.update(id, body);
  }

  @Get('rozmowy')
  rozmowy(@Query('limit') limit?: string) {
    return this.conversations.recent(Math.min(Number(limit) || 20, 200));
  }

  @Get('rozmowy/:id')
  rozmowa(@Param('id') id: string) {
    return this.conversations.detail(id);
  }

  @Get('wiedza/luki')
  luki(@Query('od') od?: string, @Query('do') to?: string) {
    return this.metrics.luki(parseOkres(od, to, 30));
  }

  @Get('raporty/najnowszy')
  raport(@Query('lang') l?: string) {
    return this.reports.latestReport(lang(l));
  }

  @Get('publikacje')
  publikacje(@Query('status') status?: string) {
    return this.reports.listPublications(
      status === 'szkic' || status === 'opublikowana' ? status : undefined,
    );
  }

  @Get('publikacje/:id')
  publikacja(@Param('id') id: string, @Query('lang') l?: string) {
    return this.reports.getPublication(id, lang(l), false);
  }

  @Post('publikacje/:id/opublikuj')
  @HttpCode(200)
  opublikuj(@Param('id') id: string, @Query('lang') l?: string) {
    return this.reports.publish(id, lang(l));
  }

  @Post('demo/seed')
  seed(@Body() body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const dni = Math.min(Math.max(Number(b.dni) || 14, 1), 60);
    const rozmow = Math.min(Math.max(Number(b.rozmow) || 120, 1), 1000);
    return this.demo.seed(dni, rozmow);
  }

  @Delete('demo')
  clearDemo() {
    return this.demo.clear();
  }
}

/** Jobs for cron (x-cron-secret) or the panel (Bearer admin token). */
@Controller('halohub/jobs')
@UseGuards(new SecretGuard({ header: 'x-cron-secret', env: 'HALOHUB_CRON_SECRET' }, ADMIN))
export class JobsController {
  constructor(
    private readonly topics: TopicsService,
    private readonly reports: ReportService,
    private readonly ingest: IngestService,
  ) {}

  @Post('tematy')
  @HttpCode(200)
  tematy() {
    return this.topics.recompute();
  }

  @Post('raport-dzienny')
  @HttpCode(200)
  raport() {
    return this.reports.generateDaily();
  }

  @Post('ingest')
  @HttpCode(202)
  startIngest(@Body() body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    return this.ingest.start({
      zrodla: Array.isArray(b.zrodla) ? b.zrodla.filter((z) => typeof z === 'string') : undefined,
      limit: Number(b.limit) > 0 ? Number(b.limit) : undefined,
    });
  }
}
