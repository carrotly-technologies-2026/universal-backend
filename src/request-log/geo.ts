import geoip from 'geoip-lite';

export interface GeoLocation {
  country: string;
  /** e.g. "PL, Kraków", "US" or "-" for private/unknown addresses. */
  label: string;
}

const UNKNOWN: GeoLocation = { country: '-', label: '-' };

export function locate(ip: string): GeoLocation {
  const geo = geoip.lookup(ip.replace(/^::ffff:/, ''));
  if (!geo?.country) return UNKNOWN;
  return {
    country: geo.country,
    label: geo.city ? `${geo.country}, ${geo.city}` : geo.country,
  };
}
