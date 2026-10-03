import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RequestLoggerMiddleware } from './request-logger.middleware.js';
import { RequestStatsService } from './request-stats.service.js';
import { StatsController } from './stats.controller.js';

@Module({
  controllers: [StatsController],
  providers: [RequestStatsService],
})
export class RequestLogModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggerMiddleware).forRoutes('{*path}');
  }
}
