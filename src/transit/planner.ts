import { Network, normalizeName } from './gtfs.js';

export interface Leg {
  linia: string;
  rodzaj: 'tramwaj' | 'autobus' | 'inny';
  kierunek: string;
  z: string;
  z_slupek: string;
  odjazd: string;
  do: string;
  przyjazd: string;
  przystankow: number;
}

export interface Journey {
  odjazd: string;
  przyjazd: string;
  za_min: number;
  czas_min: number;
  przesiadki: number;
  odcinki: Leg[];
  /** Ready-to-say Polish description. */
  opis: string;
}

export interface PlanResult {
  skad: string[];
  dokad: string[];
  polaczenia: Journey[];
  /** Further departures of the best journey's first line. */
  nastepne_odjazdy: string[];
}

export interface StopMatch {
  name: string;
  stops: number[];
  score: number;
}

// Spoken names → stop name prefixes used in the Kraków feeds.
const ALIASES: Record<string, string> = {
  dworzec: 'dworzec glowny',
  'dworzec pkp': 'dworzec glowny',
  'galeria krakowska': 'dworzec glowny',
  hackyeah: 'tauron arena krakow',
  'tauron arena': 'tauron arena krakow',
  'tauron': 'tauron arena krakow',
  arena: 'tauron arena krakow',
  rynek: 'plac wszystkich swietych',
  'rynek glowny': 'plac wszystkich swietych',
  wawel: 'wawel',
  kazimierz: 'plac wolnica',
  'rondo grunwaldzkie': 'rondo grunwaldzkie',
};

const TRANSFER_MIN_S = 120;
const TRANSFER_MAX_S = 30 * 60;
const WINDOW_S = 90 * 60;

/** Stop groups (same name) matching a spoken name, best first. */
export function matchStops(net: Network, query: string): StopMatch[] {
  let q = normalizeName(query).replace(/^(przystanek|przystanku|ulica|ul|plac|pl|al|aleja) /, '');
  q = ALIASES[q] ?? q;
  if (!q) return [];
  const tokens = q.split(' ');
  const out: StopMatch[] = [];
  for (const [norm, stops] of net.groups) {
    let score = 0;
    if (norm === q) score = 100;
    else if (norm.startsWith(q + ' ') || norm.startsWith(q)) score = 80 - (norm.length - q.length) / 10;
    else if (tokens.every((t) => norm.includes(t))) score = 50 - (norm.length - q.length) / 10;
    else {
      const hit = tokens.filter((t) => t.length > 2 && norm.split(' ').some((w) => w.startsWith(t.slice(0, Math.max(4, t.length - 2))))).length;
      if (hit) score = (20 * hit) / tokens.length;
    }
    if (score > 0) out.push({ name: net.stopName[stops[0]], stops, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Matches good enough to use: the best score band (e.g. all "Dworzec Główny …" platforms). */
function usable(matches: StopMatch[]): StopMatch[] {
  // A partial word match ("Teatr …" for "Teatr Bagatela") would send people to the wrong place.
  if (!matches.length || matches[0].score < 40) return [];
  const best = matches[0].score;
  const floor = best >= 80 ? 60 : 40;
  return matches.filter((m) => m.score >= floor).slice(0, 6);
}

const hhmm = (s: number) => {
  const t = ((s % 86400) + 86400) % 86400;
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
};

interface Dep {
  pos: number;
  trip: number;
  /** Departure in seconds since the query day's midnight (yesterday's after-midnight trips are shifted). */
  t: number;
}

/** Departures from the given stops in [from, to), today's services and yesterday's late trips. */
function departures(net: Network, stops: Iterable<number>, from: number, to: number, today: Set<string>, yesterday: Set<string>): Dep[] {
  const out: Dep[] = [];
  for (const s of stops) {
    for (let i = net.byStopStart[s]; i < net.byStopStart[s + 1]; i++) {
      const pos = net.byStopEntry[i];
      const trip = tripOf(net, pos);
      const raw = net.stTime[pos];
      const svc = net.tripService[trip];
      // A trip's last stop is an arrival, not a departure.
      if (pos === net.tripStart[trip] + net.tripLen[trip] - 1) continue;
      if (today.has(svc) && raw >= from && raw < to) out.push({ pos, trip, t: raw });
      else if (yesterday.has(svc) && raw - 86400 >= from && raw - 86400 < to) out.push({ pos, trip, t: raw - 86400 });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// Position → trip, via binary search over trip starts (built lazily).
const tripIndexCache = new WeakMap<Network, { starts: Int32Array; trips: Int32Array }>();
function tripOf(net: Network, pos: number): number {
  let idx = tripIndexCache.get(net);
  if (!idx) {
    const trips = Int32Array.from({ length: net.tripStart.length }, (_, i) => i).filter((t) => net.tripStart[t] >= 0);
    trips.sort((a, b) => net.tripStart[a] - net.tripStart[b]);
    idx = { trips, starts: Int32Array.from(trips, (t) => net.tripStart[t]) };
    tripIndexCache.set(net, idx);
  }
  let lo = 0;
  let hi = idx.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (idx.starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return idx.trips[lo];
}

function leg(net: Network, trip: number, fromPos: number, toPos: number, shift: number): Leg {
  return {
    linia: net.tripRoute[trip],
    rodzaj: net.tripMode[trip],
    kierunek: net.tripHeadsign[trip],
    z: net.stopName[net.stStop[fromPos]],
    z_slupek: net.stopCode[net.stStop[fromPos]],
    odjazd: hhmm(net.stTime[fromPos] - shift),
    do: net.stopName[net.stStop[toPos]],
    przyjazd: hhmm(net.stTime[toPos] - shift),
    przystankow: toPos - fromPos,
  };
}

function przystanki(n: number): string {
  if (n === 1) return 'przystanek';
  const d = n % 10;
  const t = n % 100;
  return d >= 2 && d <= 4 && (t < 12 || t > 14) ? 'przystanki' : 'przystanków';
}

const RODZAJ: Record<Leg['rodzaj'], string> = { tramwaj: 'tramwaj', autobus: 'autobus', inny: 'pojazd' };

function describe(j: Omit<Journey, 'opis'>): string {
  const parts = j.odcinki.map((l, i) => {
    const start = i === 0 ? `Z przystanku ${l.z}` : `Na przystanku ${l.z} proszę się przesiąść:`;
    const stops = `${l.przystankow} ${przystanki(l.przystankow)}`;
    return `${start} ${RODZAJ[l.rodzaj]} linii ${l.linia} w kierunku ${l.kierunek}, odjazd o ${l.odjazd}. Jedzie się ${stops}, do przystanku ${l.do}, przyjazd o ${l.przyjazd}.`;
  });
  const when = j.za_min <= 0 ? 'odjeżdża teraz' : `odjazd za ${j.za_min} min`;
  return `${parts.join(' ')} (${when}, cała podróż ok. ${j.czas_min} min${j.przesiadki ? `, ${j.przesiadki} przesiadka` : ''}).`;
}

/**
 * Direct and one-transfer journeys from `from` to `to`, leaving within the
 * next 90 minutes after `now` (seconds since midnight, Kraków time).
 */
export function plan(
  net: Network,
  fromQuery: string,
  toQuery: string,
  now: number,
  date: string,
  yesterdayDate: string,
): PlanResult | { blad: string; podpowiedzi: string[] } {
  const fromMatches = usable(matchStops(net, fromQuery));
  const toMatches = usable(matchStops(net, toQuery));
  if (!fromMatches.length || !toMatches.length) {
    const which = !fromMatches.length ? fromQuery : toQuery;
    return {
      blad: `Nie znam przystanku „${which}”. Zapytaj o nazwę najbliższego przystanku.`,
      podpowiedzi: matchStops(net, which.split(' ')[0] ?? which).slice(0, 5).map((m) => m.name),
    };
  }
  const today = net.services.get(date) ?? new Set<string>();
  const yesterday = net.services.get(yesterdayDate) ?? new Set<string>();
  const fromStops = new Set(fromMatches.flatMap((m) => m.stops));
  const toStops = new Set(toMatches.flatMap((m) => m.stops));
  const journeys: Omit<Journey, 'opis'>[] = [];

  const reachTarget = (trip: number, pos: number): number => {
    const end = net.tripStart[trip] + net.tripLen[trip];
    for (let p = pos + 1; p < end; p++) if (toStops.has(net.stStop[p])) return p;
    return -1;
  };

  const deps = departures(net, fromStops, now, now + WINDOW_S, today, yesterday);
  for (const d of deps) {
    const shift = net.stTime[d.pos] - d.t;
    const p = reachTarget(d.trip, d.pos);
    if (p >= 0) {
      journeys.push(make(now, [leg(net, d.trip, d.pos, p, shift)], d.t, net.stTime[p] - shift));
      continue;
    }
  }

  // One transfer at a stop group (same name) along the first trip.
  const firstDeps = deps.slice(0, 80);
  for (const d of firstDeps) {
    const shift = net.stTime[d.pos] - d.t;
    const end = net.tripStart[d.trip] + net.tripLen[d.trip];
    for (let p = d.pos + 1; p < end; p++) {
      const arr = net.stTime[p] - shift;
      const group = net.groups.get(net.stopNorm[net.stStop[p]]) ?? [];
      if (group.some((s) => fromStops.has(s))) continue;
      for (const d2 of departures(net, group, arr + TRANSFER_MIN_S, arr + TRANSFER_MAX_S, today, yesterday)) {
        if (net.tripRoute[d2.trip] === net.tripRoute[d.trip]) continue;
        const q = reachTarget(d2.trip, d2.pos);
        if (q < 0) continue;
        const shift2 = net.stTime[d2.pos] - d2.t;
        journeys.push(
          make(now, [leg(net, d.trip, d.pos, p, shift), leg(net, d2.trip, d2.pos, q, shift2)], d.t, net.stTime[q] - shift2),
        );
        break; // the first matching departure is the earliest for this transfer stop
      }
    }
  }

  // Best per line combination, ranked by arrival with a 5-minute penalty per transfer.
  const best = new Map<string, Omit<Journey, 'opis'>>();
  const rank = (j: Omit<Journey, 'opis'>) => j.za_min + j.czas_min + 5 * j.przesiadki;
  for (const j of journeys) {
    const k = j.odcinki.map((l) => `${l.linia}>${l.kierunek}`).join('|');
    const cur = best.get(k);
    if (!cur || rank(j) < rank(cur)) best.set(k, j);
  }
  const ranked = [...best.values()].sort((a, b) => rank(a) - rank(b));
  // Drop transfer options that are not faster than a direct one.
  const fastestDirect = ranked.find((j) => j.przesiadki === 0);
  const top = ranked
    .filter((j) => !fastestDirect || j.przesiadki === 0 || rank(j) + 3 < rank(fastestDirect))
    .slice(0, 3);

  const first = top[0]?.odcinki[0];
  const nastepne = first
    ? journeys
        .filter((j) => j.odcinki.length === 1 && j.odcinki[0].linia === first.linia && j.odcinki[0].kierunek === first.kierunek && j.odjazd > first.odjazd)
        .map((j) => j.odjazd)
        .filter((t, i, a) => a.indexOf(t) === i)
        .slice(0, 2)
    : [];

  return {
    skad: fromMatches.map((m) => m.name),
    dokad: toMatches.map((m) => m.name),
    polaczenia: top.map((j) => ({ ...j, opis: describe(j) })),
    nastepne_odjazdy: nastepne,
  };
}

function make(now: number, odcinki: Leg[], dep: number, arr: number): Omit<Journey, 'opis'> {
  return {
    odjazd: odcinki[0].odjazd,
    przyjazd: odcinki[odcinki.length - 1].przyjazd,
    za_min: Math.max(0, Math.round((dep - now) / 60)),
    czas_min: Math.round((arr - dep) / 60),
    przesiadki: odcinki.length - 1,
    odcinki,
  };
}
