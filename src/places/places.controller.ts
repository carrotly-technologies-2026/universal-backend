import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { PlacesService } from './places.service.js';

/** Public places search (restaurants, sights, toilets…) near a stop or landmark. */
@Controller('places')
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  @Get('providers')
  providers() {
    return this.places.providers();
  }

  /** ?kategoria=&gdzie=&kuchnia=&wozek=true&limit= */
  @Get()
  search(@Query() q: Record<string, string | undefined>) {
    if (!q.kategoria) throw new BadRequestException('kategoria is required.');
    return this.places.search({
      kategoria: q.kategoria,
      gdzie: q.gdzie?.slice(0, 120),
      kuchnia: q.kuchnia?.slice(0, 40),
      dlaWozka: q.wozek === 'true',
      limit: q.limit ? Number(q.limit) : undefined,
    });
  }
}
