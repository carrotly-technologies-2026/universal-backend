import { Injectable, Logger } from '@nestjs/common';
import { TransitService } from '../transit/transit.service.js';
import {
  Experience,
  geocode,
  Kategoria,
  KATEGORIE,
  Place,
  Query,
  searchOsm,
  searchTripadvisor,
  searchViator,
  tripadvisorSupports,
  viatorEnabled,
} from './providers.js';

export interface PlacesRequest {
  kategoria: string;
  /** Stop, landmark or street; default: Rynek Główny. */
  gdzie?: string | null;
  kuchnia?: string | null;
  dlaWozka?: boolean;
  promienM?: number;
  limit?: number;
}

export interface PlacesResult {
  miejsce_odniesienia: string;
  miejsca: (Place & { najblizszy_przystanek: string | null })[];
  wycieczki: Experience[];
  zrodla: string[];
  komunikat: string | null;
}

const DEFAULT_PLACE = { name: 'Rynek Główny', lat: 50.0617, lon: 19.9373 };
const CACHE_MS = 6 * 3_600_000;

/**
 * Places near a stop or landmark: OpenStreetMap always, Tripadvisor ratings
 * and Viator tours when their API keys are set. Results are cached for 6 h
 * (Overpass and Nominatim are shared public services).
 */
@Injectable()
export class PlacesService {
  private readonly logger = new Logger(PlacesService.name);
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly transit: TransitService) {}

  providers() {
    return {
      openstreetmap: true,
      tripadvisor: Boolean(process.env.TRIPADVISOR_API_KEY),
      viator: viatorEnabled(),
    };
  }

  async search(r: PlacesRequest): Promise<PlacesResult> {
    const kategoria = (KATEGORIE as string[]).includes(r.kategoria) ? (r.kategoria as Kategoria) : null;
    if (!kategoria && r.kategoria !== 'wycieczka') {
      return { miejsce_odniesienia: '', miejsca: [], wycieczki: [], zrodla: [], komunikat: `Nieznana kategoria. Dostępne: ${[...KATEGORIE, 'wycieczka'].join(', ')}.` };
    }
    const limit = Math.min(Math.max(r.limit ?? 3, 1), 8);
    const where = await this.resolve(r.gdzie);
    if (!where) {
      return { miejsce_odniesienia: r.gdzie ?? '', miejsca: [], wycieczki: [], zrodla: [], komunikat: `Nie wiem, gdzie jest „${r.gdzie}”. Zapytaj o najbliższy przystanek albo znane miejsce obok.` };
    }
    const zrodla = new Set<string>();
    let komunikat: string | null = null;

    let wycieczki: Experience[] = [];
    if (r.kategoria === 'wycieczka' || kategoria === 'atrakcja') {
      if (viatorEnabled()) {
        try {
          wycieczki = await this.cached(`viator|${r.kuchnia ?? ''}|${kategoria}`, () =>
            searchViator(r.kategoria === 'wycieczka' ? (r.kuchnia ?? '') : 'tour', limit),
          );
          if (wycieczki.length) zrodla.add('Viator');
        } catch (err) {
          this.logger.warn(`Viator: ${String(err)}`);
        }
      } else if (r.kategoria === 'wycieczka') {
        komunikat = 'Wyszukiwarka wycieczek (Viator) nie jest włączona – poleć atrakcje i punkty informacji turystycznej InfoKraków.';
      }
    }

    let miejsca: Place[] = [];
    if (kategoria) {
      const q: Query = {
        kategoria,
        lat: where.lat,
        lon: where.lon,
        promienM: Math.min(Math.max(r.promienM ?? (['toaleta', 'bankomat', 'apteka'].includes(kategoria) ? 500 : 800), 100), 3000),
        kuchnia: r.kuchnia,
        dlaWozka: r.dlaWozka,
      };
      if (tripadvisorSupports(kategoria) && !r.dlaWozka) {
        try {
          miejsca = await this.cached(`ta|${JSON.stringify(q)}|${limit}`, () => searchTripadvisor(q, limit + 2));
          if (r.kuchnia) {
            const want = r.kuchnia.toLowerCase();
            const filtered = miejsca.filter((m) => m.kuchnia?.toLowerCase().includes(want));
            if (filtered.length) miejsca = filtered;
          }
        } catch (err) {
          this.logger.warn(`Tripadvisor: ${String(err)}`);
        }
      }
      if (!miejsca.length) {
        try {
          miejsca = await this.cached(`osm|${JSON.stringify(q)}`, () => searchOsm(q));
        } catch (err) {
          this.logger.warn(`Overpass: ${String(err)}`);
          komunikat = 'Wyszukiwarka miejsc chwilowo nie odpowiada.';
        }
      }
      miejsca = miejsca.slice(0, limit);
      for (const m of miejsca) zrodla.add(m.zrodlo);
      if (!miejsca.length && !komunikat) komunikat = 'Nic takiego nie znalazłam w pobliżu – zaproponuj większy obszar albo inne miejsce.';
    }

    return {
      miejsce_odniesienia: where.name,
      miejsca: miejsca.map((m) => ({ ...m, najblizszy_przystanek: this.transit.nearestStop(m.lat, m.lon)?.name ?? null })),
      wycieczki,
      zrodla: [...zrodla],
      komunikat,
    };
  }

  private async resolve(gdzie?: string | null): Promise<{ name: string; lat: number; lon: number } | null> {
    if (!gdzie?.trim()) return DEFAULT_PLACE;
    const stop = this.transit.locate(gdzie);
    if (stop) return stop;
    try {
      return await this.cached(`geo|${gdzie.toLowerCase()}`, () => geocode(gdzie));
    } catch (err) {
      this.logger.warn(`Nominatim: ${String(err)}`);
      return null;
    }
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
}
