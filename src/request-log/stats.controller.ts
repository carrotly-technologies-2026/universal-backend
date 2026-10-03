import { Controller, Get, Header, Req, Res } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { locate } from './geo.js';
import { GroupStats, RequestStatsService } from './request-stats.service.js';

@Controller('stats')
export class StatsController {
  constructor(private readonly stats: RequestStatsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  show(@Req() req: Request, @Res() res: Response): void {
    const password = process.env.STATS_PASSWORD;
    if (!password) {
      res
        .status(503)
        .send('Stats disabled: set the STATS_PASSWORD env variable.');
      return;
    }
    if (!isAuthorized(req.headers.authorization, password)) {
      res
        .status(401)
        .setHeader('WWW-Authenticate', 'Basic realm="stats", charset="UTF-8"')
        .send('Unauthorized');
      return;
    }
    res.type('html').send(this.render());
  }

  private render(): string {
    const s = this.stats;
    const statusRows = [...s.byStatus]
      .sort(([a], [b]) => a - b)
      .map(([status, count]) => [String(status), String(count)]);
    const ipRows = groupRows(s.byIp).map(([ip, ...rest]) => [
      ip,
      locate(ip).label,
      ...rest,
      s.byIp.get(ip)!.lastUserAgent,
    ]);
    const routeRows = groupRows(s.byRoute).map(([route, ...rest]) => {
      const g = s.byRoute.get(route)!;
      return [
        route,
        ...rest,
        `${(g.totalDurationMs / g.requests).toFixed(1)} ms`,
      ];
    });
    const recentRows = s.recent.map((e) => [
      fmtDate(e.time),
      e.ip,
      e.location,
      `${e.method} ${e.url}`,
      e.completed ? String(e.status) : `${e.status} aborted`,
      `${e.durationMs.toFixed(1)} ms`,
      e.userAgent,
    ]);

    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Request stats</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 16px; color: #222; }
  h2 { margin-top: 28px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { background: #f3f3f3; position: sticky; top: 0; }
  td { word-break: break-all; }
  .muted { color: #777; }
</style></head><body>
<h1>Request stats</h1>
<p>${s.total} requests since ${fmtDate(s.startedAt)} (UTC) · ${s.byIp.size} IPs · ${s.byCountry.size} countries · ${s.byRoute.size} routes
<br><span class="muted">In memory: resets on restart/deploy. Refresh to update.</span></p>
<h2>By status</h2>
${table(['Status', 'Requests'], statusRows)}
<h2>By IP</h2>
${table(['IP', 'Location', 'Requests', 'Errors', 'Last seen (UTC)', 'Last user agent'], ipRows)}
<h2>By country</h2>
${table(['Country', 'Requests', 'Errors', 'Last seen (UTC)'], groupRows(s.byCountry))}
<h2>By route</h2>
${table(['Route', 'Requests', 'Errors', 'Last seen (UTC)', 'Avg time'], routeRows)}
<h2>Last ${s.recent.length} requests</h2>
${table(['Time (UTC)', 'IP', 'Location', 'Request', 'Status', 'Time', 'User agent'], recentRows)}
</body></html>`;
  }
}

function isAuthorized(header: string | undefined, password: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const given = decoded.slice(decoded.indexOf(':') + 1);
  // Hash both sides so the comparison is constant-time regardless of length.
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(given), digest(password));
}

function groupRows(map: Map<string, GroupStats>): string[][] {
  return [...map]
    .sort(([, a], [, b]) => b.requests - a.requests)
    .map(([key, g]) => [
      key,
      String(g.requests),
      String(g.errors),
      fmtDate(g.lastSeen),
    ]);
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p class="muted">No data yet.</p>';
  const head = headers.map((h) => `<th>${escape(h)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${escape(c)}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

function fmtDate(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// URLs and user agents are attacker-controlled; escape everything rendered.
function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
