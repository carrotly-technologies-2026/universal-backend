import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();

    // 'close' fires for completed and aborted requests alike, unlike 'finish'.
    res.on('close', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      this.logger.log(
        JSON.stringify({
          method: req.method,
          url: req.originalUrl,
          status: res.statusCode,
          completed: res.writableFinished,
          durationMs: Math.round(durationMs * 100) / 100,
          ip: req.ip,
          forwardedFor: req.headers['x-forwarded-for'],
          userAgent: req.headers['user-agent'],
          referer: req.headers.referer,
          host: req.headers.host,
          httpVersion: req.httpVersion,
          requestBytes: req.headers['content-length'],
          responseBytes: res.getHeader('content-length'),
        }),
      );
    });

    next();
  }
}
