import { strToU8, zipSync } from 'fflate';
import { buildNetwork } from './gtfs.js';
import { matchStops, plan } from './planner.js';
import { localClock } from './transit.service.js';

const csv = (rows: string[][]) => rows.map((r) => r.join(',')).join('\n') + '\n';

// Tram 1: A → B → C. Tram 2: C → D (transfer at C). Bus 3: A → D after midnight (yesterday's service).
function feed() {
  return zipSync({
    'stops.txt': strToU8(csv([
      ['stop_id', 'stop_name', 'stop_desc'],
      ['a1', '"Dworzec Główny Tunel"', '01'],
      ['b1', 'Rondo Mogilskie', '01'],
      ['c1', 'Czyżyny', '01'],
      ['c2', 'Czyżyny', '02'],
      ['d1', 'TAURON Arena Kraków Wieczysta', '01'],
    ])),
    'routes.txt': strToU8(csv([
      ['route_id', 'route_short_name', 'route_type'],
      ['r1', '1', '900'],
      ['r2', '2', '900'],
      ['r3', '3', '3'],
    ])),
    'trips.txt': strToU8(csv([
      ['route_id', 'service_id', 'trip_id', 'trip_headsign'],
      ['r1', 'sob', 't1', 'Czyżyny'],
      ['r1', 'sob', 't1b', 'Czyżyny'],
      ['r2', 'sob', 't2', 'Arena'],
      ['r3', 'pt', 't3', 'Arena'],
    ])),
    'stop_times.txt': strToU8(csv([
      ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'],
      ['t1', '10:00:00', '10:00:00', 'a1', '1'],
      ['t1', '10:05:00', '10:05:00', 'b1', '2'],
      ['t1', '10:10:00', '10:10:00', 'c1', '3'],
      ['t1b', '10:20:00', '10:20:00', 'a1', '1'],
      ['t1b', '10:30:00', '10:30:00', 'c1', '2'],
      ['t2', '10:15:00', '10:15:00', 'c2', '1'],
      ['t2', '10:20:00', '10:20:00', 'd1', '2'],
      ['t3', '24:30:00', '24:30:00', 'a1', '1'],
      ['t3', '24:50:00', '24:50:00', 'd1', '2'],
    ])),
    'calendar_dates.txt': strToU8(csv([
      ['service_id', 'date', 'exception_type'],
      ['sob', '20261003', '1'],
      ['pt', '20261002', '1'],
    ])),
  });
}

describe('transit planner', () => {
  const net = buildNetwork([{ id: 'test', zip: feed() }]);

  it('matches spoken stop names', () => {
    expect(matchStops(net, 'dworzec')[0].name).toBe('Dworzec Główny Tunel');
    expect(matchStops(net, 'hackyeah')[0].name).toBe('TAURON Arena Kraków Wieczysta');
    expect(matchStops(net, 'czyzyny')[0].stops).toHaveLength(2);
  });

  it('finds a direct trip with line, direction, times and stop count', () => {
    const r = plan(net, 'Dworzec Główny', 'Czyżyny', 9 * 3600 + 55 * 60, '20261003', '20261002');
    if ('blad' in r) throw new Error(r.blad);
    expect(r.polaczenia[0]).toMatchObject({ odjazd: '10:00', przyjazd: '10:10', za_min: 5, przesiadki: 0 });
    expect(r.polaczenia[0].odcinki[0]).toMatchObject({ linia: '1', rodzaj: 'tramwaj', kierunek: 'Czyżyny', przystankow: 2 });
    expect(r.polaczenia[0].opis).toContain('tramwaj linii 1 w kierunku Czyżyny, odjazd o 10:00');
    expect(r.nastepne_odjazdy).toEqual(['10:20']);
  });

  it('finds a journey with one transfer between platforms of the same stop', () => {
    const r = plan(net, 'Dworzec Główny Tunel', 'Tauron Arena', 9 * 3600 + 55 * 60, '20261003', '20261002');
    if ('blad' in r) throw new Error(r.blad);
    const j = r.polaczenia[0];
    expect(j.przesiadki).toBe(1);
    expect(j.odcinki.map((l) => l.linia)).toEqual(['1', '2']);
    expect(j.opis).toContain('Na przystanku Czyżyny proszę się przesiąść');
  });

  it("uses yesterday's after-midnight trips and today's services only", () => {
    const r = plan(net, 'Dworzec Główny', 'Tauron Arena', 20 * 60, '20261003', '20261002');
    if ('blad' in r) throw new Error(r.blad);
    expect(r.polaczenia[0].odcinki[0]).toMatchObject({ linia: '3', rodzaj: 'autobus', odjazd: '00:30' });
    const none = plan(net, 'Dworzec Główny', 'Czyżyny', 9 * 3600, '20261005', '20261004');
    expect('blad' in none ? [] : none.polaczenia).toEqual([]);
  });

  it('refuses unknown stops instead of guessing', () => {
    expect(plan(net, 'Teatr Bagatela', 'Czyżyny', 0, '20261003', '20261002')).toMatchObject({ blad: expect.stringContaining('Teatr Bagatela') });
  });

  it('computes Kraków local time', () => {
    expect(localClock(new Date('2026-10-03T22:30:00Z'))).toEqual({ date: '20261004', yesterday: '20261003', seconds: 30 * 60 });
  });
});
