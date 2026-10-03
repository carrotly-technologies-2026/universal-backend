import { locate } from './geo.js';

describe('locate', () => {
  it('resolves public IPv4, IPv4-mapped IPv6 and unknown addresses', () => {
    expect(locate('83.0.0.1').country).toBe('PL');
    expect(locate('::ffff:83.0.0.1').country).toBe('PL');
    expect(locate('127.0.0.1')).toEqual({ country: '-', label: '-' });
    expect(locate('-')).toEqual({ country: '-', label: '-' });
  });
});
