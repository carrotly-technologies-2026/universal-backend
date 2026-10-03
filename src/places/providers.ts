/**
 * Place and experience providers. OpenStreetMap needs no key and is always
 * on; TripAdvisor Content API and Viator Partner API add ratings and tours
 * when their keys are set (scraping those sites is against their terms).
 */

export type Kategoria =
  | 'restauracja'
  | 'kawiarnia'
  | 'bar'
  | 'szybkie_jedzenie'
  | 'lody'
  | 'atrakcja'
  | 'muzeum'
  | 'park'
  | 'punkt_widokowy'
  | 'toaleta'
  | 'apteka'
  | 'bankomat'
  | 'kantor'
  | 'informacja_turystyczna'
  | 'sklep_spozywczy';

export const KATEGORIE: Kategoria[] = [
  'restauracja', 'kawiarnia', 'bar', 'szybkie_jedzenie', 'lody', 'atrakcja', 'muzeum', 'park',
  'punkt_widokowy', 'toaleta', 'apteka', 'bankomat', 'kantor', 'informacja_turystyczna', 'sklep_spozywczy',
];

// Overpass QL selectors per category.
const OSM: Record<Kategoria, string[]> = {
  restauracja: ['nwr["amenity"="restaurant"]'],
  kawiarnia: ['nwr["amenity"="cafe"]'],
  bar: ['nwr["amenity"~"^(bar|pub)$"]'],
  szybkie_jedzenie: ['nwr["amenity"="fast_food"]'],
  lody: ['nwr["amenity"="ice_cream"]'],
  atrakcja: ['nwr["tourism"~"^(attraction|gallery)$"]', 'nwr["historic"~"^(castle|monument|memorial|city_gate)$"]["name"]'],
  muzeum: ['nwr["tourism"="museum"]'],
  park: ['nwr["leisure"="park"]["name"]'],
  punkt_widokowy: ['nwr["tourism"="viewpoint"]'],
  toaleta: ['nwr["amenity"="toilets"]'],
  apteka: ['nwr["amenity"="pharmacy"]'],
  bankomat: ['nwr["amenity"="atm"]'],
  kantor: ['nwr["amenity"="bureau_de_change"]'],
  informacja_turystyczna: ['nwr["tourism"="information"]["information"="office"]'],
  sklep_spozywczy: ['nwr["shop"~"^(supermarket|convenience)$"]'],
};

export interface Place {
  nazwa: string;
  rodzaj: string;
  kuchnia: string | null;
  adres: string | null;
  lat: number;
  lon: number;
  odleglosc_m: number;
  /** OpenStreetMap opening_hours syntax, e.g. "Mo-Su 10:00-22:00". */
  godziny: string | null;
  dla_wozka: 'tak' | 'czesciowo' | 'nie' | null;
  strona: string | null;
  telefon: string | null;
  ocena: number | null;
  opinie: number | null;
  ranking: string | null;
  cena: string | null;
  zrodlo: string;
}

export interface Experience {
  tytul: string;
  ocena: number | null;
  opinie: number | null;
  cena_od: string | null;
  czas: string | null;
  url: string | null;
  zrodlo: 'Viator';
}

export interface Query {
  kategoria: Kategoria;
  lat: number;
  lon: number;
  promienM: number;
  kuchnia?: string | null;
  dlaWozka?: boolean;
}

const UA = 'universal-backend/1.0 (Halo, Hub! / MayAI; HackYeah 2026)';

export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(a));
}

export function overpassQuery(q: Query): string {
  const around = `(around:${Math.round(q.promienM)},${q.lat.toFixed(6)},${q.lon.toFixed(6)})`;
  const wheel = q.dlaWozka ? '["wheelchair"~"^(yes|limited)$"]' : '';
  const parts = OSM[q.kategoria].map((sel) => `${sel}${wheel}${around};`).join('');
  return `[out:json][timeout:20];(${parts});out center tags 80;`;
}

type OsmElement = { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };

/** Normalizes Overpass elements; cuisine filter matches cuisine and diet tags. */
export function parseOsm(elements: OsmElement[], q: Query): Place[] {
  const want = q.kuchnia ? normalize(q.kuchnia) : null;
  const out: Place[] = [];
  for (const e of elements) {
    const t = e.tags ?? {};
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const name = t['name:pl'] || t.name || t['name:en'];
    if (!name && !['toaleta', 'bankomat'].includes(q.kategoria)) continue;
    const cuisine = [t.cuisine, ...Object.keys(t).filter((k) => k.startsWith('diet:') && /yes|only/.test(t[k])).map((k) => k.slice(5))]
      .filter(Boolean)
      .join(';');
    if (want && !normalize(cuisine).includes(cuisineAlias(want))) continue;
    const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    out.push({
      nazwa: name || (q.kategoria === 'toaleta' ? 'Toaleta publiczna' : 'Bankomat'),
      rodzaj: q.kategoria,
      kuchnia: cuisine ? cuisine.replaceAll('_', ' ').replaceAll(';', ', ') : null,
      adres: street || null,
      lat,
      lon,
      odleglosc_m: Math.round(distanceM(q.lat, q.lon, lat, lon)),
      godziny: t.opening_hours ?? null,
      dla_wozka: t.wheelchair === 'yes' ? 'tak' : t.wheelchair === 'limited' ? 'czesciowo' : t.wheelchair === 'no' ? 'nie' : null,
      strona: t.website || t['contact:website'] || null,
      telefon: t.phone || t['contact:phone'] || null,
      ocena: null,
      opinie: null,
      ranking: null,
      cena: null,
      zrodlo: 'OpenStreetMap',
    });
  }
  // Better-documented places first (they are usually established), then distance.
  const richness = (p: Place) => (p.godziny ? 1 : 0) + (p.strona ? 1 : 0) + (p.adres ? 1 : 0);
  return out.sort((a, b) => richness(b) - richness(a) || a.odleglosc_m - b.odleglosc_m);
}

function normalize(s: string): string {
  return s.toLowerCase().replaceAll('ł', 'l').normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

// Spoken (Polish/English) cuisine words → OSM cuisine values.
const CUISINE: Record<string, string> = {
  polska: 'polish', polskie: 'polish', 'kuchnia polska': 'polish', pierogi: 'pierogi',
  wloska: 'italian', pizza: 'pizza', wegetarianska: 'vegetarian', weganska: 'vegan', vegan: 'vegan',
  wegetarianskie: 'vegetarian', zydowska: 'jewish', ukrainska: 'ukrainian', kebab: 'kebab',
  azjatycka: 'asian', japonska: 'japanese', sushi: 'sushi', burger: 'burger', burgery: 'burger',
  bezglutenowa: 'gluten_free', indyjska: 'indian', chinska: 'chinese', meksykanska: 'mexican',
};
function cuisineAlias(s: string): string {
  return CUISINE[s] ?? s;
}

// Public Overpass instances are often busy (429/504); try the next one.
const OVERPASS = () =>
  (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter').split(',');

export async function searchOsm(q: Query): Promise<Place[]> {
  let last: unknown;
  for (const endpoint of OVERPASS()) {
    try {
      const res = await fetch(endpoint.trim(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        body: `data=${encodeURIComponent(overpassQuery(q))}`,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      const json = (await res.json()) as { elements?: OsmElement[] };
      return parseOsm(json.elements ?? [], q);
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Free-text place lookup (OSM Nominatim) limited to Kraków, for names that are not stops. */
export async function geocode(query: string): Promise<{ name: string; lat: number; lon: number } | null> {
  const url = new URL(process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('viewbox', '19.79,50.13,20.22,49.97');
  url.searchParams.set('bounded', '1');
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'pl' }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return null;
  const [hit] = (await res.json()) as { display_name: string; lat: string; lon: string; name?: string }[];
  return hit ? { name: hit.name || hit.display_name.split(',')[0], lat: Number(hit.lat), lon: Number(hit.lon) } : null;
}

// --- TripAdvisor Content API (optional: TRIPADVISOR_API_KEY) -------------

const TA_CATEGORY: Partial<Record<Kategoria, string>> = {
  restauracja: 'restaurants', kawiarnia: 'restaurants', bar: 'restaurants', szybkie_jedzenie: 'restaurants', lody: 'restaurants',
  atrakcja: 'attractions', muzeum: 'attractions', park: 'attractions', punkt_widokowy: 'attractions',
};

interface TaDetails {
  location_id: string;
  name: string;
  rating?: string;
  num_reviews?: string;
  ranking_data?: { ranking_string?: string };
  price_level?: string;
  cuisine?: { localized_name?: string; name?: string }[];
  address_obj?: { street1?: string; address_string?: string };
  latitude?: string;
  longitude?: string;
  web_url?: string;
  website?: string;
  phone?: string;
  hours?: { weekday_text?: string[] };
}

export function tripadvisorSupports(k: Kategoria): boolean {
  return Boolean(process.env.TRIPADVISOR_API_KEY && TA_CATEGORY[k]);
}

export function parseTripadvisor(d: TaDetails, q: Query): Place {
  const lat = Number(d.latitude ?? q.lat);
  const lon = Number(d.longitude ?? q.lon);
  return {
    nazwa: d.name,
    rodzaj: q.kategoria,
    kuchnia: d.cuisine?.map((c) => c.localized_name || c.name).filter(Boolean).join(', ') || null,
    adres: d.address_obj?.street1 || d.address_obj?.address_string || null,
    lat,
    lon,
    odleglosc_m: Math.round(distanceM(q.lat, q.lon, lat, lon)),
    godziny: d.hours?.weekday_text?.join('; ') ?? null,
    dla_wozka: null,
    strona: d.website || d.web_url || null,
    telefon: d.phone ?? null,
    ocena: d.rating ? Number(d.rating) : null,
    opinie: d.num_reviews ? Number(d.num_reviews) : null,
    ranking: d.ranking_data?.ranking_string ?? null,
    cena: d.price_level ?? null,
    zrodlo: 'Tripadvisor',
  };
}

export async function searchTripadvisor(q: Query, limit: number): Promise<Place[]> {
  const key = process.env.TRIPADVISOR_API_KEY!;
  const base = 'https://api.content.tripadvisor.com/api/v1/location';
  const nearby = new URL(`${base}/nearby_search`);
  nearby.searchParams.set('latLong', `${q.lat},${q.lon}`);
  nearby.searchParams.set('category', TA_CATEGORY[q.kategoria]!);
  nearby.searchParams.set('radius', String(Math.max(q.promienM, 100)));
  nearby.searchParams.set('radiusUnit', 'm');
  nearby.searchParams.set('language', 'pl');
  nearby.searchParams.set('key', key);
  const res = await fetch(nearby, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Tripadvisor HTTP ${res.status}`);
  const list = ((await res.json()) as { data?: { location_id: string }[] }).data ?? [];
  const details = await Promise.all(
    list.slice(0, limit).map(async ({ location_id }) => {
      const u = new URL(`${base}/${location_id}/details`);
      u.searchParams.set('language', 'pl');
      u.searchParams.set('currency', 'PLN');
      u.searchParams.set('key', key);
      const r = await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
      return r.ok ? ((await r.json()) as TaDetails) : null;
    }),
  );
  return details
    .filter((d): d is TaDetails => !!d?.name)
    .map((d) => parseTripadvisor(d, q))
    .sort((a, b) => (b.ocena ?? 0) * Math.log10((b.opinie ?? 0) + 10) - (a.ocena ?? 0) * Math.log10((a.opinie ?? 0) + 10));
}

// --- Viator Partner API (optional: VIATOR_API_KEY) -----------------------

interface ViatorProduct {
  title?: string;
  reviews?: { combinedAverageRating?: number; totalReviews?: number };
  pricing?: { summary?: { fromPrice?: number }; currency?: string };
  duration?: { fixedDurationInMinutes?: number; variableDurationFromMinutes?: number; variableDurationToMinutes?: number };
  productUrl?: string;
}

export function viatorEnabled(): boolean {
  return Boolean(process.env.VIATOR_API_KEY);
}

export function parseViator(p: ViatorProduct, currency: string): Experience {
  const d = p.duration;
  const minutes = d?.fixedDurationInMinutes ?? d?.variableDurationFromMinutes;
  return {
    tytul: p.title ?? '',
    ocena: p.reviews?.combinedAverageRating ?? null,
    opinie: p.reviews?.totalReviews ?? null,
    cena_od: p.pricing?.summary?.fromPrice !== undefined ? `${Math.round(p.pricing.summary.fromPrice)} ${p.pricing.currency ?? currency}` : null,
    czas: minutes ? (minutes >= 60 ? `${Math.round(minutes / 30) / 2} h` : `${minutes} min`) : null,
    url: p.productUrl ?? null,
    zrodlo: 'Viator',
  };
}

export async function searchViator(term: string, limit: number, language = 'pl'): Promise<Experience[]> {
  const currency = 'PLN';
  const res = await fetch(`${process.env.VIATOR_API_URL || 'https://api.viator.com/partner'}/search/freetext`, {
    method: 'POST',
    headers: {
      'exp-api-key': process.env.VIATOR_API_KEY!,
      accept: 'application/json;version=2.0',
      'accept-language': language === 'pl' ? 'pl-PL' : 'en-US',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      searchTerm: `Kraków ${term}`.trim(),
      currency,
      searchTypes: [{ searchType: 'PRODUCTS', pagination: { start: 1, count: Math.min(limit * 2, 20) } }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Viator HTTP ${res.status}`);
  const json = (await res.json()) as { products?: { results?: ViatorProduct[] } };
  return (json.products?.results ?? [])
    .map((p) => parseViator(p, currency))
    .filter((e) => e.tytul)
    .sort((a, b) => (b.ocena ?? 0) * Math.log10((b.opinie ?? 0) + 10) - (a.ocena ?? 0) * Math.log10((a.opinie ?? 0) + 10))
    .slice(0, limit);
}
