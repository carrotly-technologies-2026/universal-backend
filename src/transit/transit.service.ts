import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildNetwork, FeedFile, Network } from './gtfs.js';
import { matchStops, plan } from './planner.js';

// Kraków trams and buses (ZTP, updated daily).
const DEFAULT_FEEDS =
  'krakow_t=https://gtfs.ztp.krakow.pl/GTFS_KRK_T.zip,krakow_a=https://gtfs.ztp.krakow.pl/GTFS_KRK_A.zip';
const REFRESH_MS = 12 * 3_600_000;

const warsaw = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Kraków-local date (YYYYMMDD), the day before, and seconds since local midnight. */
export function localClock(at: Date) {
  const p = Object.fromEntries(warsaw.formatToParts(at).map((x) => [x.type, x.value]));
  const date = `${p.year}${p.month}${p.day}`;
  const noonUtc = Date.UTC(+p.year, +p.month - 1, +p.day, 12);
  const y = new Date(noonUtc - 86_400_000);
  const yesterday = `${y.getUTCFullYear()}${String(y.getUTCMonth() + 1).padStart(2, '0')}${String(y.getUTCDate()).padStart(2, '0')}`;
  return { date, yesterday, seconds: +p.hour * 3600 + +p.minute * 60 + +p.second };
}

/**
 * Generic public-transport journey planner on GTFS static feeds
 * (TRANSIT_GTFS_FEEDS="id=url,id=url"; empty string disables it). Feeds are
 * cached in DATA_DIR/gtfs and reloaded every 12 h.
 */
@Injectable()
export class TransitService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TransitService.name);
  private network: Network | null = null;
  private loadedAt: Date | null = null;
  private loading: Promise<void> | null = null;
  private timer?: NodeJS.Timeout;

  onApplicationBootstrap(): void {
    if (!this.feeds().length) return;
    // In the background: the app must not wait for ~150 MB of timetables.
    void this.reload();
    this.timer = setInterval(() => void this.reload(), REFRESH_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  status() {
    const n = this.network;
    return {
      gotowy: !!n,
      wczytano: this.loadedAt,
      wersje: n?.feedVersions ?? {},
      przystanki: n?.stopName.length ?? 0,
      kursy: n?.tripRoute.length ?? 0,
    };
  }

  stops(query: string) {
    return matchStops(this.require(), query)
      .slice(0, 10)
      .map((m) => ({ nazwa: m.name, slupki: m.stops.length, trafnosc: Math.round(m.score) }));
  }

  /** Centre of the best-matching stop group, e.g. to search places nearby. */
  locate(query: string): { name: string; lat: number; lon: number } | null {
    if (!this.network) return null;
    const best = matchStops(this.network, query).find((m) => m.score >= 40);
    if (!best) return null;
    const n = this.network;
    const lat = best.stops.reduce((a, s) => a + n.stopLat[s], 0) / best.stops.length;
    const lon = best.stops.reduce((a, s) => a + n.stopLon[s], 0) / best.stops.length;
    return { name: best.name, lat, lon };
  }

  /** Nearest stop name to a point (straight line). */
  nearestStop(lat: number, lon: number): { name: string; distanceM: number } | null {
    const n = this.network;
    if (!n) return null;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < n.stopName.length; i++) {
      const d = distanceM(lat, lon, n.stopLat[i], n.stopLon[i]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best < 0 ? null : { name: n.stopName[best], distanceM: Math.round(bestD) };
  }

  plan(from: string, to: string, at = new Date()) {
    const { date, yesterday, seconds } = localClock(at);
    return plan(this.require(), from, to, seconds, date, yesterday);
  }

  /** Loads (or reloads) all feeds; resolves once the network is usable. */
  reload(): Promise<void> {
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async ready(): Promise<void> {
    if (!this.network && this.loading) await this.loading;
  }

  private require(): Network {
    if (!this.network) {
      throw new ServiceUnavailableException(
        this.feeds().length ? 'Timetables are still loading.' : 'Transit disabled: set TRANSIT_GTFS_FEEDS.',
      );
    }
    return this.network;
  }

  private feeds(): { id: string; url: string }[] {
    const raw = process.env.TRANSIT_GTFS_FEEDS ?? DEFAULT_FEEDS;
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf('=');
        return { id: s.slice(0, i), url: s.slice(i + 1) };
      });
  }

  private async load(): Promise<void> {
    try {
      const started = Date.now();
      const files: FeedFile[] = [];
      for (const f of this.feeds()) files.push({ id: f.id, zip: await this.fetchFeed(f.id, f.url) });
      this.network = buildNetwork(files);
      this.loadedAt = new Date();
      this.logger.log(
        `GTFS loaded in ${Date.now() - started} ms: ${this.network.stopName.length} stops, ${this.network.tripRoute.length} trips (${JSON.stringify(this.network.feedVersions)})`,
      );
    } catch (err) {
      // Keep serving the previous network if a refresh fails.
      this.logger.error(`GTFS load failed: ${String(err)}`);
    }
  }

  /** The feed zip, from cache when younger than the refresh interval. */
  private async fetchFeed(id: string, url: string): Promise<Uint8Array> {
    const dir = join(process.env.DATA_DIR ?? './data', 'gtfs');
    const file = join(dir, `${id}.zip`);
    try {
      const s = await stat(file);
      if (Date.now() - s.mtimeMs < REFRESH_MS) return new Uint8Array(await readFile(file));
    } catch {
      // Not cached yet.
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = new Uint8Array(await res.arrayBuffer());
      await mkdir(dir, { recursive: true });
      await writeFile(file, body);
      return body;
    } catch (err) {
      // Offline or the publisher is down: an older cached copy is better than nothing.
      this.logger.warn(`GTFS download ${id} failed (${String(err)}), trying cache.`);
      return new Uint8Array(await readFile(file));
    }
  }
}

/** Haversine distance in metres. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(a));
}
