import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { TransitService } from './transit.service.js';

/** Public journey planner on open timetable data (GTFS). */
@Controller('transit')
export class TransitController {
  constructor(private readonly transit: TransitService) {}

  @Get()
  status() {
    return this.transit.status();
  }

  @Get('stops')
  stops(@Query('q') q?: string) {
    if (!q?.trim()) throw new BadRequestException('q is required.');
    return this.transit.stops(q.slice(0, 100));
  }

  /** ?skad=&dokad=&kiedy=ISO (default now). */
  @Get('plan')
  plan(@Query('skad') from?: string, @Query('dokad') to?: string, @Query('kiedy') when?: string) {
    if (!from?.trim() || !to?.trim()) throw new BadRequestException('skad and dokad are required.');
    const at = when ? new Date(when) : new Date();
    if (Number.isNaN(at.getTime())) throw new BadRequestException('kiedy must be an ISO date.');
    return this.transit.plan(from.slice(0, 100), to.slice(0, 100), at);
  }
}
