import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SecretGuard } from '../common/secret.guard.js';
import { RopsService, Wiadomosc } from './rops.service.js';

/** Fixed-window limit per client IP; the endpoints are public and call the LLM. */
class RateLimit {
  private readonly hits = new Map<string, { start: number; n: number }>();
  constructor(private readonly max: number, private readonly windowMs: number) {}
  check(ip: string) {
    const now = Date.now();
    const h = this.hits.get(ip);
    if (!h || now - h.start > this.windowMs) {
      this.hits.set(ip, { start: now, n: 1 });
      if (this.hits.size > 10_000) this.hits.clear();
      return;
    }
    if (++h.n > this.max) throw new HttpException('Za dużo zapytań – spróbuj za chwilę.', HttpStatus.TOO_MANY_REQUESTS);
  }
}

const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10) : undefined);

/** Public "Asystent wiedzy ROPS" API (chat line + advanced search) and its voice tool. */
@Controller('halohub')
export class RopsController {
  private readonly askLimit = new RateLimit(Number(process.env.ROPS_ASK_LIMIT || 30), 10 * 60_000);
  private readonly searchLimit = new RateLimit(240, 10 * 60_000);

  constructor(private readonly rops: RopsService) {}

  @Get('public/rops/facety')
  facety() {
    return this.rops.facety();
  }

  /** ?q=&zrodla=biblioteka,raporty&kategorie=&grupa=&limit=&offset= ; empty q browses. */
  @Get('public/rops/szukaj')
  szukaj(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    this.searchLimit.check(req.ip ?? '');
    return this.rops.szukaj({
      q: q.q?.slice(0, 300),
      zrodla: list(q.zrodla),
      kategorie: list(q.kategorie),
      grupa: q.grupa || undefined,
      limit: Math.min(Math.max(Number(q.limit) || 10, 1), 30),
      offset: Math.min(Math.max(Number(q.offset) || 0, 0), 300),
    });
  }

  /** body { pytanie, historia?: { rola: 'uzytkownik'|'asystent', tresc }[] } */
  @Post('public/rops/zapytaj')
  @HttpCode(200)
  zapytaj(@Req() req: Request, @Body() body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.pytanie !== 'string' || !b.pytanie.trim()) {
      throw new BadRequestException('pytanie must be a non-empty string.');
    }
    this.askLimit.check(req.ip ?? '');
    const historia: Wiadomosc[] = Array.isArray(b.historia)
      ? b.historia
          .filter((m): m is Wiadomosc => !!m && typeof m === 'object' && typeof (m as Wiadomosc).tresc === 'string')
          .map((m): Wiadomosc => ({ rola: m.rola === 'asystent' ? 'asystent' : 'uzytkownik', tresc: m.tresc }))
          .slice(-10)
      : [];
    return this.rops.zapytaj(b.pytanie, historia);
  }

  /** Voice line tool for the ROPS ElevenLabs agent. */
  @Post('tools/szukaj_w_rops')
  @HttpCode(200)
  @UseGuards(new SecretGuard({ header: 'x-tool-secret', env: 'HALOHUB_TOOL_SECRET' }))
  async dlaGlosu(@Body() body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.pytanie !== 'string' || !b.pytanie.trim()) {
      return { wyniki: [], komunikat: 'Brak pytania.' };
    }
    try {
      return await this.rops.dlaGlosu(b.pytanie);
    } catch {
      return { wyniki: [], komunikat: 'Wyszukiwarka chwilowo nie odpowiada.' };
    }
  }
}
