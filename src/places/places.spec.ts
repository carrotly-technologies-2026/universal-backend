import { overpassQuery, parseOsm, parseTripadvisor, parseViator, Query } from './providers.js';

const Q: Query = { kategoria: 'restauracja', lat: 50.0617, lon: 19.9373, promienM: 800 };

describe('places providers', () => {
  it('builds an Overpass query around the point with an optional wheelchair filter', () => {
    const q = overpassQuery({ ...Q, dlaWozka: true });
    expect(q).toContain('nwr["amenity"="restaurant"]["wheelchair"~"^(yes|limited)$"](around:800,50.061700,19.937300);');
    expect(q).toMatch(/^\[out:json\]/);
  });

  it('normalizes OSM elements, filters cuisine (incl. diet tags) and ranks documented places first', () => {
    const places = parseOsm(
      [
        { lat: 50.062, lon: 19.938, tags: { name: 'Pierogarnia', cuisine: 'polish;pierogi', opening_hours: 'Mo-Su 11:00-22:00', 'addr:street': 'Grodzka', 'addr:housenumber': '1', wheelchair: 'yes' } },
        { lat: 50.0618, lon: 19.9374, tags: { name: 'Bistro', cuisine: 'polish' } },
        { center: { lat: 50.07, lon: 19.94 }, tags: { name: 'Zielona', 'diet:vegan': 'only' } },
        { lat: 50.06, lon: 19.93, tags: { cuisine: 'polish' } }, // no name → skipped
      ],
      { ...Q, kuchnia: 'polska' },
    );
    expect(places.map((p) => p.nazwa)).toEqual(['Pierogarnia', 'Bistro']);
    expect(places[0]).toMatchObject({ adres: 'Grodzka 1', godziny: 'Mo-Su 11:00-22:00', dla_wozka: 'tak', kuchnia: 'polish, pierogi', zrodlo: 'OpenStreetMap' });
    expect(parseOsm([{ center: { lat: 50.07, lon: 19.94 }, tags: { name: 'Zielona', 'diet:vegan': 'only' } }], { ...Q, kuchnia: 'wegańska' })).toHaveLength(1);
  });

  it('maps Tripadvisor details and Viator products', () => {
    expect(
      parseTripadvisor(
        { location_id: '1', name: 'Wierzynek', rating: '4.5', num_reviews: '3200', ranking_data: { ranking_string: '#12 z 3000 restauracji w Krakowie' }, price_level: '$$$$', cuisine: [{ localized_name: 'Polska' }], latitude: '50.0615', longitude: '19.9378' },
        Q,
      ),
    ).toMatchObject({ nazwa: 'Wierzynek', ocena: 4.5, opinie: 3200, kuchnia: 'Polska', cena: '$$$$', zrodlo: 'Tripadvisor' });
    expect(
      parseViator({ title: 'Wieliczka Salt Mine tour', reviews: { combinedAverageRating: 4.7, totalReviews: 9000 }, pricing: { summary: { fromPrice: 289.4 }, currency: 'PLN' }, duration: { fixedDurationInMinutes: 330 }, productUrl: 'https://x' }, 'PLN'),
    ).toEqual({ tytul: 'Wieliczka Salt Mine tour', ocena: 4.7, opinie: 9000, cena_od: '289 PLN', czas: '5.5 h', url: 'https://x', zrodlo: 'Viator' });
  });
});
