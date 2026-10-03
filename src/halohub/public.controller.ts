import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { Metryki } from './metrics.js';
import { TematPubliczny } from './model.js';
import { lang } from './panel.controller.js';
import { pelna, ReportService } from './report.service.js';

const LICENCJA = 'CC BY 4.0';

/**
 * Public page and open data. Only the latest *published* snapshot is ever
 * shown (PLAN.md 9.6), never live data.
 */
@Controller('halohub/public')
export class PublicController {
  constructor(private readonly reports: ReportService) {}

  @Get('info')
  info() {
    const numer = process.env.INBOUND_NUMBER || '+420910923449';
    return {
      numer: formatNumber(numer),
      numer_tel: numer,
      elevenlabs_agent_id: process.env.ELEVENLABS_AGENT_ID || null,
      rops_agent_id: process.env.ELEVENLABS_ROPS_AGENT_ID || null,
    };
  }

  @Get('publikacja')
  async latest(@Query('lang') l?: string) {
    return pelna(await this.reports.latestPublished(), lang(l));
  }

  @Get('publikacje')
  list() {
    return this.reports.listPublications('opublikowana');
  }

  @Get('publikacje/:id')
  one(@Param('id') id: string, @Query('lang') l?: string) {
    return this.reports.getPublication(id, lang(l), true);
  }

  @Get('metryki.json')
  @Header('Cache-Control', 'public, max-age=300')
  async metrykiJson() {
    const p = await this.reports.latestPublished();
    return { ...naglowek(p), metryki: p.metryki };
  }

  @Get('metryki.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="halohub-metryki.csv"')
  async metrykiCsv() {
    const p = await this.reports.latestPublished();
    const h = naglowek(p);
    const rows = flattenMetrics(p.metryki as Metryki).map((r) => [
      h.okres_od, h.okres_do, h.opublikowano, h.wersja_definicji, ...r,
    ]);
    return csv(
      ['okres_od', 'okres_do', 'opublikowano', 'wersja_definicji', 'metryka', 'podzial', 'klucz', 'wartosc'],
      rows,
    );
  }

  @Get('tematy.json')
  @Header('Cache-Control', 'public, max-age=300')
  async tematyJson() {
    const p = await this.reports.latestPublished();
    return { ...naglowek(p), tematy: p.tematy };
  }

  @Get('tematy.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="halohub-tematy.csv"')
  async tematyCsv() {
    const p = await this.reports.latestPublished();
    const h = naglowek(p);
    const cols: (keyof TematPubliczny)[] = [
      'priorytet', 'tytul', 'kategoria', 'miejsce', 'dzielnica',
      'liczba_zgloszen', 'wynik', 'status', 'grupy', 'jezyki',
    ];
    return csv(
      ['okres_od', 'okres_do', 'opublikowano', 'wersja_definicji', ...cols],
      p.tematy.map((t) => [
        h.okres_od, h.okres_do, h.opublikowano, h.wersja_definicji,
        ...cols.map((c) => (Array.isArray(t[c]) ? (t[c] as string[]).join(';') : t[c])),
      ]),
    );
  }
}

function naglowek(p: Awaited<ReturnType<ReportService['latestPublished']>>) {
  return {
    okres_od: p.okres_od.toISOString(),
    okres_do: p.okres_do.toISOString(),
    opublikowano: p.opublikowano?.toISOString() ?? '',
    wersja_definicji: p.wersja_definicji,
    licencja: LICENCJA,
    zrodlo: 'Halo, Hub! – zgłoszenia z rozmów telefonicznych',
    dane_przykladowe: p.demo,
  };
}

/** [metryka, podzial, klucz, wartosc] rows for every number in the metrics. */
export function flattenMetrics(m: Metryki): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [];
  const skip = new Set(['okres_od', 'okres_do', 'jezyk', 'wersja_definicji', 'demo']);
  for (const [name, value] of Object.entries(m)) {
    if (skip.has(name)) continue;
    if (value === null || typeof value === 'number') {
      rows.push([name, '', '', value]);
      continue;
    }
    for (const [part, v] of Object.entries(value as Record<string, unknown>)) {
      if (part === 'razem') rows.push([name, '', '', v as number | null]);
      else if (Array.isArray(v)) {
        for (const d of v as { dzien: string; liczba: number }[]) rows.push([name, part, d.dzien, d.liczba]);
      } else if (v && typeof v === 'object') {
        for (const [k, n] of Object.entries(v)) rows.push([name, part, k, n as number | null]);
      }
    }
  }
  return rows;
}

function csv(header: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

function formatNumber(e164: string): string {
  // +420910923449 → +420 910 923 449
  const m = e164.match(/^\+(\d{2,3})(\d{3})(\d{3})(\d{3})$/);
  return m ? `+${m[1]} ${m[2]} ${m[3]} ${m[4]}` : e164;
}
