import { Injectable } from '@nestjs/common';

export interface RequestEntry {
  time: Date;
  method: string;
  url: string;
  path: string;
  status: number;
  completed: boolean;
  durationMs: number;
  ip: string;
  country: string;
  location: string;
  userAgent: string;
}

export interface GroupStats {
  requests: number;
  errors: number;
  totalDurationMs: number;
  lastSeen: Date;
  lastUserAgent: string;
}

// Scanners hit endless random URLs/IPs; cap distinct keys so memory stays bounded.
const MAX_KEYS = 5000;
const OVERFLOW_KEY = '(other)';
const RECENT_LIMIT = 200;

/** In-memory request statistics since process start (reset on restart/deploy). */
@Injectable()
export class RequestStatsService {
  readonly startedAt = new Date();
  readonly byIp = new Map<string, GroupStats>();
  readonly byRoute = new Map<string, GroupStats>();
  readonly byCountry = new Map<string, GroupStats>();
  readonly byStatus = new Map<number, number>();
  readonly recent: RequestEntry[] = [];
  total = 0;

  record(entry: RequestEntry): void {
    this.total++;
    this.bump(this.byIp, entry.ip, entry);
    this.bump(this.byRoute, `${entry.method} ${entry.path}`, entry);
    this.bump(this.byCountry, entry.country, entry);
    this.byStatus.set(entry.status, (this.byStatus.get(entry.status) ?? 0) + 1);
    this.recent.unshift(entry);
    if (this.recent.length > RECENT_LIMIT) this.recent.pop();
  }

  private bump(
    map: Map<string, GroupStats>,
    key: string,
    entry: RequestEntry,
  ): void {
    if (!map.has(key) && map.size >= MAX_KEYS) key = OVERFLOW_KEY;
    const stats = map.get(key) ?? {
      requests: 0,
      errors: 0,
      totalDurationMs: 0,
      lastSeen: entry.time,
      lastUserAgent: '',
    };
    stats.requests++;
    if (entry.status >= 400 || !entry.completed) stats.errors++;
    stats.totalDurationMs += entry.durationMs;
    stats.lastSeen = entry.time;
    stats.lastUserAgent = entry.userAgent;
    map.set(key, stats);
  }
}
