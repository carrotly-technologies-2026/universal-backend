import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { MongoService } from '../database/mongo.service.js';
import { HalohubStore } from './halohub.store.js';
import { IngestService } from './ingest/ingest.service.js';
import { dzien } from './metrics.js';
import { ReportService } from './report.service.js';
import { TopicsService } from './topics.service.js';

const TICK_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

const warsawHour = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Warsaw',
  hour: 'numeric',
  hourCycle: 'h23',
});

/**
 * In-process cron (enable with HALOHUB_SCHEDULER=true, one instance only):
 * topics hourly, daily report after HALOHUB_REPORT_HOUR (Kraków time),
 * weekly ingest. Due work is decided from the database, so restarts and
 * deploys do not skip or repeat it.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SchedulerService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private lastTopics = 0;

  constructor(
    private readonly mongo: MongoService,
    private readonly store: HalohubStore,
    private readonly topics: TopicsService,
    private readonly reports: ReportService,
    private readonly ingest: IngestService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.HALOHUB_SCHEDULER !== 'true' || !this.mongo.enabled) return;
    this.logger.log('Halo, Hub! scheduler enabled.');
    setTimeout(() => void this.tick(), 30_000).unref();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date();
      if (now.getTime() - this.lastTopics >= HOUR_MS) {
        this.lastTopics = now.getTime();
        await this.run('topics', () => this.topics.recompute(now));
      }
      if (await this.reportDue(now)) {
        await this.run('daily report', () => this.reports.generateDaily(now));
      }
      if (await this.ingestDue(now)) {
        await this.run('ingest', () => this.ingest.start());
      }
    } finally {
      this.ticking = false;
    }
  }

  private async reportDue(now: Date): Promise<boolean> {
    const hour = Number(process.env.HALOHUB_REPORT_HOUR || 7);
    if (Number(warsawHour.format(now)) < hour) return false;
    const last = await (await this.store.raporty())
      .find()
      .sort({ utworzono: -1 })
      .limit(1)
      .next();
    return !last || dzien(last.utworzono) !== dzien(now);
  }

  private async ingestDue(now: Date): Promise<boolean> {
    if (process.env.HALOHUB_AUTO_INGEST === 'false' || this.ingest.busy) return false;
    const last = await (await this.store.ingest())
      .find()
      .sort({ start: -1 })
      .limit(1)
      .next();
    if (!last) return true;
    // A run interrupted by a restart stays "trwa"; retry it after a day.
    if (last.status === 'trwa') return now.getTime() - last.start.getTime() > 24 * HOUR_MS;
    return now.getTime() - last.start.getTime() > WEEK_MS;
  }

  private async run(name: string, job: () => Promise<unknown>): Promise<void> {
    try {
      const result = await job();
      this.logger.log(`Job ${name}: ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Job ${name} failed: ${String(err)}`);
    }
  }
}
