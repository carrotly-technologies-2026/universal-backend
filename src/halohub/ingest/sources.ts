/**
 * hubMI / ROPS Kraków sources (PLAN.md 6.2), as of 3.10.2026. hubmi.pl
 * launches 4.10.2026; re-check these addresses afterwards.
 */
export const BASE = 'https://rops.krakow.pl';

export const BIBLIOTEKA = `${BASE}/innowacje-spoleczne/biblioteka-innowacji-spolecznych`;

/** Library category slug → caller groups (`typ_uzytkownika`) it serves. */
export const KATEGORIE_BIBLIOTEKI: Record<string, string[]> = {
  'dla-seniorow': ['senior'],
  'dla-osob-o-ograniczonej-mobilnosci': ['wozek', 'chodzik'],
  'dla-osob-z-niepelnosprawnoscia-sensoryczna': ['senior', 'inny'],
  'dla-cudzoziemcow': ['obcokrajowiec'],
  'dla-dzieci-mlodziezy-i-rodziny': ['wozek_dzieciecy'],
  'dla-zdrowia-i-medycyny': ['inny'],
  'dla-rynku-pracy': ['inny'],
  'dla-osob-w-kryzysie-bezdomnosci': ['inny'],
  'dla-osob-z-niepelnosprawnoscia-intelektualna': ['inny'],
};

export const NAZWY_KATEGORII: Record<string, string> = {
  'dla-seniorow': 'Dla seniorów',
  'dla-osob-o-ograniczonej-mobilnosci': 'Dla osób o ograniczonej mobilności',
  'dla-osob-z-niepelnosprawnoscia-sensoryczna': 'Dla osób z niepełnosprawnością sensoryczną',
  'dla-cudzoziemcow': 'Dla cudzoziemców',
  'dla-dzieci-mlodziezy-i-rodziny': 'Dla dzieci, młodzieży i rodziny',
  'dla-zdrowia-i-medycyny': 'Dla zdrowia i medycyny',
  'dla-rynku-pracy': 'Dla rynku pracy',
  'dla-osob-w-kryzysie-bezdomnosci': 'Dla osób w kryzysie bezdomności',
  'dla-osob-z-niepelnosprawnoscia-intelektualna': 'Dla osób z niepełnosprawnością intelektualną',
};

export const RAPORTY = `${BASE}/badania-analizy-raporty/raporty-z-badan`;
export const PUBLIKACJE = `${BASE}/innowacje-spoleczne/publikacje-ze-swiata-innowacji`;
export const MAPA_WYZWAN = `${BASE}/mpliki/IS/IWS_20/za._nr_2._Mapa_Wyzwa_Spoecznych.pdf`;

/** Terms-of-use PDF linked from every library entry; not content. */
export const POMIJANE_PDF = /Zasady_wykorzystania_innowacji/i;

export const ZRODLA = ['biblioteka', 'raporty', 'mapa_wyzwan', 'publikacje'] as const;
export type Zrodlo = (typeof ZRODLA)[number];

export const USER_AGENT = 'HaloHubBot (HackYeah 2026)';
