import { unzipSync } from 'fflate';

/**
 * Compact in-memory GTFS network (static schedule). Several feeds (e.g. trams
 * and buses) are merged into one network so journeys can change between them
 * at stops with the same name.
 */
export interface Network {
  stopName: string[];
  /** Normalized name; stops with the same one form a transfer group. */
  stopNorm: string[];
  stopCode: string[];
  groups: Map<string, number[]>;
  tripRoute: string[];
  tripMode: ('tramwaj' | 'autobus' | 'inny')[];
  tripHeadsign: string[];
  tripService: string[];
  tripStart: Int32Array;
  tripLen: Int32Array;
  /** stop_times of all trips, contiguous per trip in stop order. */
  stStop: Int32Array;
  stTime: Int32Array;
  /** Departures per stop (CSR): byStopStart[s]..byStopStart[s+1] index byStopEntry (positions in st*). */
  byStopStart: Int32Array;
  byStopEntry: Int32Array;
  /** YYYYMMDD → active service keys. */
  services: Map<string, Set<string>>;
  feedVersions: Record<string, string>;
}

export interface FeedFile {
  id: string;
  zip: Uint8Array;
}

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replaceAll('ł', 'l')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** RFC 4180-ish CSV rows (GTFS fields have no embedded newlines). */
function* rows(text: string): Generator<string[]> {
  let start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, text[end - 1] === '\r' ? end - 1 : end);
    start = end + 1;
    if (!line) continue;
    if (!line.includes('"')) {
      yield line.split(',');
      continue;
    }
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') {
        out.push(cur);
        cur = '';
      } else cur += c;
    }
    out.push(cur);
    yield out;
  }
}

function table(text: string | undefined): { header: Map<string, number>; rows: Generator<string[]> } {
  const it = rows(text ?? '');
  const first = it.next();
  const header = new Map<string, number>(
    (first.done ? [] : first.value).map((h, i) => [h.trim(), i]),
  );
  return { header, rows: it };
}

const col = (header: Map<string, number>, name: string) => header.get(name) ?? -1;

function seconds(hms: string): number {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

const MODES: Record<string, Network['tripMode'][number]> = {
  '0': 'tramwaj',
  '900': 'tramwaj',
  '3': 'autobus',
  '700': 'autobus',
};

export function buildNetwork(feeds: FeedFile[]): Network {
  const net: Network = {
    stopName: [],
    stopNorm: [],
    stopCode: [],
    groups: new Map(),
    tripRoute: [],
    tripMode: [],
    tripHeadsign: [],
    tripService: [],
    tripStart: new Int32Array(0),
    tripLen: new Int32Array(0),
    stStop: new Int32Array(0),
    stTime: new Int32Array(0),
    byStopStart: new Int32Array(0),
    byStopEntry: new Int32Array(0),
    services: new Map(),
    feedVersions: {},
  };
  const rawTrip: number[] = [];
  const rawSeq: number[] = [];
  const rawStop: number[] = [];
  const rawTime: number[] = [];
  const decoder = new TextDecoder();

  for (const feed of feeds) {
    const files = unzipSync(feed.zip, {
      filter: (f) =>
        ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt', 'feed_info.txt'].includes(f.name),
    });
    const text = (name: string) => (files[name] ? decoder.decode(files[name]) : undefined);
    const key = (id: string) => `${feed.id}:${id}`;

    const info = table(text('feed_info.txt'));
    for (const r of info.rows) net.feedVersions[feed.id] = r[col(info.header, 'feed_version')] ?? '';

    const stopIdx = new Map<string, number>();
    const st = table(text('stops.txt'));
    for (const r of st.rows) {
      const name = r[col(st.header, 'stop_name')];
      const i = net.stopName.length;
      stopIdx.set(r[col(st.header, 'stop_id')], i);
      net.stopName.push(name);
      net.stopNorm.push(normalizeName(name));
      net.stopCode.push(r[col(st.header, 'stop_desc')] || r[col(st.header, 'platform_code')] || '');
    }

    const routes = new Map<string, { name: string; mode: Network['tripMode'][number] }>();
    const rt = table(text('routes.txt'));
    for (const r of rt.rows) {
      routes.set(r[col(rt.header, 'route_id')], {
        name: r[col(rt.header, 'route_short_name')] || r[col(rt.header, 'route_long_name')],
        mode: MODES[r[col(rt.header, 'route_type')]] ?? 'inny',
      });
    }

    const tripIdx = new Map<string, number>();
    const tr = table(text('trips.txt'));
    for (const r of tr.rows) {
      const route = routes.get(r[col(tr.header, 'route_id')]);
      if (!route) continue;
      tripIdx.set(r[col(tr.header, 'trip_id')], net.tripRoute.length);
      net.tripRoute.push(route.name);
      net.tripMode.push(route.mode);
      net.tripHeadsign.push(r[col(tr.header, 'trip_headsign')] ?? '');
      net.tripService.push(key(r[col(tr.header, 'service_id')]));
    }

    const stt = table(text('stop_times.txt'));
    const cTrip = col(stt.header, 'trip_id');
    const cSeq = col(stt.header, 'stop_sequence');
    const cStop = col(stt.header, 'stop_id');
    const cDep = col(stt.header, 'departure_time');
    const cArr = col(stt.header, 'arrival_time');
    for (const r of stt.rows) {
      const t = tripIdx.get(r[cTrip]);
      const s = stopIdx.get(r[cStop]);
      const time = r[cDep] || r[cArr];
      if (t === undefined || s === undefined || !time) continue;
      rawTrip.push(t);
      rawSeq.push(Number(r[cSeq]));
      rawStop.push(s);
      rawTime.push(seconds(time));
    }

    addCalendar(net, table(text('calendar.txt')), table(text('calendar_dates.txt')), key);
  }

  for (let i = 0; i < net.stopNorm.length; i++) {
    const g = net.groups.get(net.stopNorm[i]) ?? [];
    g.push(i);
    net.groups.set(net.stopNorm[i], g);
  }

  // Sort stop_times by (trip, sequence) into contiguous arrays.
  const order = Int32Array.from({ length: rawTrip.length }, (_, i) => i).sort(
    (a, b) => rawTrip[a] - rawTrip[b] || rawSeq[a] - rawSeq[b],
  );
  const n = order.length;
  net.stStop = new Int32Array(n);
  net.stTime = new Int32Array(n);
  net.tripStart = new Int32Array(net.tripRoute.length).fill(-1);
  net.tripLen = new Int32Array(net.tripRoute.length);
  for (let k = 0; k < n; k++) {
    const i = order[k];
    net.stStop[k] = rawStop[i];
    net.stTime[k] = rawTime[i];
    const t = rawTrip[i];
    if (net.tripStart[t] < 0) net.tripStart[t] = k;
    net.tripLen[t]++;
  }

  // Departures per stop, sorted by time.
  const counts = new Int32Array(net.stopName.length + 1);
  for (let k = 0; k < n; k++) counts[net.stStop[k] + 1]++;
  for (let s = 0; s < net.stopName.length; s++) counts[s + 1] += counts[s];
  net.byStopStart = counts.slice();
  const fill = counts.slice();
  net.byStopEntry = new Int32Array(n);
  for (let k = 0; k < n; k++) net.byStopEntry[fill[net.stStop[k]]++] = k;
  for (let s = 0; s < net.stopName.length; s++) {
    const seg = net.byStopEntry.subarray(net.byStopStart[s], net.byStopStart[s + 1]);
    seg.sort((a, b) => net.stTime[a] - net.stTime[b]);
  }
  return net;
}

function addCalendar(
  net: Network,
  cal: ReturnType<typeof table>,
  dates: ReturnType<typeof table>,
  key: (id: string) => string,
) {
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const add = (date: string, service: string) => {
    const set = net.services.get(date) ?? new Set();
    set.add(service);
    net.services.set(date, set);
  };
  for (const r of cal.rows) {
    const service = key(r[col(cal.header, 'service_id')]);
    const flags = days.map((d) => r[col(cal.header, d)] === '1');
    if (!flags.some(Boolean)) continue;
    const start = r[col(cal.header, 'start_date')];
    const end = r[col(cal.header, 'end_date')];
    for (let d = parseDate(start); formatDate(d) <= end; d = new Date(d.getTime() + 86_400_000)) {
      if (flags[(d.getUTCDay() + 6) % 7]) add(formatDate(d), service);
    }
  }
  for (const r of dates.rows) {
    const date = r[col(dates.header, 'date')];
    const service = key(r[col(dates.header, 'service_id')]);
    if (r[col(dates.header, 'exception_type')] === '1') add(date, service);
    else net.services.get(date)?.delete(service);
  }
}

const parseDate = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)));
const formatDate = (d: Date) => d.toISOString().slice(0, 10).replaceAll('-', '');
