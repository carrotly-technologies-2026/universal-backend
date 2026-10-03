import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ansiClient } from './client-color.js';
import { locate } from './geo.js';
import { RequestStatsService } from './request-stats.service.js';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly stats: RequestStatsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();

    // 'close' fires for completed and aborted requests alike, unlike 'finish'.
    res.on('close', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const ip = req.ip ?? '-';
      const geo = locate(ip);
      const entry = {
        time: new Date(),
        method: req.method,
        url: req.originalUrl,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        completed: res.writableFinished,
        durationMs,
        ip,
        country: geo.country,
        location: geo.label,
        userAgent: req.headers['user-agent'] ?? '-',
      };
      this.stats.record(entry);

      // e.g. 203.0.113.7 (PL, Kraków)  GET /users?page=2 → 200  3.1ms  "Mozilla/5.0 ..."
      const referer = req.headers.referer ? `  ref=${req.headers.referer}` : '';
      const level =
        entry.status >= 500 || !entry.completed
          ? 'error'
          : entry.status >= 400
            ? 'warn'
            : 'log';
      // Nest colors the message per level (red/yellow/green); resume it after the IP.
      const levelAnsi = {
        error: '\x1b[31m',
        warn: '\x1b[33m',
        log: '\x1b[32m',
      }[level];
      const line =
        `${ansiClient(entry.ip, levelAnsi)} (${entry.location})  ${entry.method} ${entry.url} → ${entry.status}` +
        `${entry.completed ? '' : ' ABORTED'}  ${durationMs.toFixed(1)}ms` +
        `  "${entry.userAgent}"${referer}`;
      this.logger[level](line);
    });

    next();
  }
}
