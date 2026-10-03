# Halo, Hub! – API backendu

Domenowy moduł generycznego backendu (`universal-backend`). Wszystkie ścieżki mają prefiks
`/halohub`. Plan produktu: `polish-stonks-bot/PLAN.md`. Daty to ISO 8601 (UTC), identyfikatory to
24-znakowe hex (`id`). Udziały/odsetki to ułamki 0–1 (frontend formatuje jako %), `null` = brak danych.

## Uwierzytelnianie

| Grupa | Nagłówek | Zmienna środowiskowa |
|---|---|---|
| `/halohub/api/*` (panel urzędnika) | `Authorization: Bearer <token>` | `HALOHUB_ADMIN_TOKEN` |
| `/halohub/jobs/*` | `x-cron-secret: <sekret>` **albo** jak panel | `HALOHUB_CRON_SECRET` |
| `/halohub/tools/*` (ElevenLabs) | `x-tool-secret` | `HALOHUB_TOOL_SECRET` |
| `/halohub/webhooks/elevenlabs` | `elevenlabs-signature` (HMAC) – tylko gdy zmienna ustawiona; bez niej webhook przyjmuje wszystko | `ELEVENLABS_WEBHOOK_SECRET` (opcjonalna) |
| `/halohub/webhooks/elevenlabs/init` | `x-init-secret` | `HALOHUB_INIT_SECRET` |
| `/halohub/public/*` | brak | – |

Brak zmiennej → 503 (funkcja wyłączona), zły sekret → 401.

## Publiczne (`/halohub/public`)

Pokazują **tylko ostatnią opublikowaną migawkę** (`status = opublikowana`), nigdy dane na żywo.

| Metoda | Ścieżka | Odpowiedź |
|---|---|---|
| GET | `/info` | `{ numer: "+420 910 923 449", numer_tel: "+420910923449", elevenlabs_agent_id: string \| null }` |
| GET | `/publikacja?lang=pl` | `Publikacja` (ostatnia opublikowana) albo 404 |
| GET | `/publikacje` | `PublikacjaSkrot[]` (archiwum opublikowanych, najnowsze pierwsze) |
| GET | `/publikacje/:id?lang=pl` | `Publikacja` (tylko opublikowana) |
| GET | `/metryki.json`, `/metryki.csv` | otwarte dane metryk, CC BY 4.0 |
| GET | `/tematy.json`, `/tematy.csv` | opublikowane tematy z priorytetem |

`lang` ∈ `pl | en | uk` (domyślnie `pl`) wybiera język `raport_md`.

## Panel (`/halohub/api`)

| Metoda | Ścieżka | Odpowiedź |
|---|---|---|
| GET | `/metryki?od=&do=&jezyk=` | `Metryki`; domyślnie ostatnie 7 dni; `jezyk` filtruje rozmowy, bariery i pytania |
| GET | `/tematy?priorytet=&status=&kategoria=&dzielnica=&jezyk=&aktywne=true&limit=100` | `Temat[]` posortowane po `wynik` malejąco |
| GET | `/tematy/:id` | `Temat & { bariery: Bariera[] }` |
| PATCH | `/tematy/:id` | body `{ status?: Status, notatka?: string }` → `Temat` |
| GET | `/rozmowy?limit=20` | `RozmowaSkrot[]` (najnowsze pierwsze, bez transkrypcji) |
| GET | `/rozmowy/:id` | `RozmowaSkrot & { potrzeby, transkrypcja (surowa tablica ElevenLabs), bariery: Bariera[], zapytania_rag, poprzednie: RozmowaSkrot[] }` – bez hasha telefonu |
| GET | `/wiedza/luki?od=&do=` | `Luki` |
| GET | `/pipeline` | `Pipeline` – stan etapów (ingest → embedding → rozmowy → tematy → raport → publikacja) i historia ingestu |
| GET | `/raporty/najnowszy?lang=pl` | `{ id, okres_od, okres_do, utworzono, zrodlo: 'llm' \| 'szablon', tresc_md: string }` albo 404 |
| GET | `/publikacje?status=szkic` | `PublikacjaSkrot[]` |
| GET | `/publikacje/:id?lang=pl` | `Publikacja` (też szkice) |
| POST | `/publikacje/:id/opublikuj` | `Publikacja` |
| POST | `/demo/seed` | body `{ dni?: 14, rozmow?: 120 }` → `{ rozmowy, bariery, zapytania }`; dane z `demo = true` |
| DELETE | `/demo` | usuwa dane demonstracyjne |

## Joby (`/halohub/jobs`)

`POST /tematy`, `POST /raport-dzienny`, `POST /ingest` (body opcjonalnie `{ zrodla?: string[], limit?: number }`).
`/ingest` działa w tle i od razu zwraca `202 { id, status: 'trwa' }`; stan w `GET /halohub/api/wiedza/luki` → `ingest`.
Na produkcji joby odpala wbudowany harmonogram (`HALOHUB_SCHEDULER=true`).

## Telefonia (ElevenLabs)

| Metoda | Ścieżka | Kto |
|---|---|---|
| POST | `/halohub/webhooks/elevenlabs/init` | webhook inicjacji rozmowy (Twilio); body `{ caller_id, ... }` → `{ type: 'conversation_initiation_client_data', dynamic_variables: { czy_powrot, poprzedni_kontekst, powitanie } }` – `powitanie`: pełne przedstawienie projektu dla nowych, krótkie powitanie w języku poprzedniej rozmowy dla powracających |
| POST | `/halohub/webhooks/elevenlabs` | webhook po rozmowie (`post_call_transcription`) |
| POST | `/halohub/tools/szukaj_wiedzy` | narzędzie agenta; body `{ pytanie, grupa?, conversation_id?, jezyk? }` → `{ wyniki: { tytul, glos_streszczenie, kontakt, url, zrodlo }[], komunikat: string \| null }` |
| POST | `/halohub/tools/znajdz_polaczenie` | narzędzie agenta; body `{ skad, dokad, kiedy? ("HH:MM"), caller_id?, conversation_id? }` → `{ skad[], dokad[], polaczenia: { odjazd, przyjazd, za_min, czas_min, przesiadki, odcinki: { linia, rodzaj, kierunek, z, z_slupek, odjazd, do, przyjazd, przystankow }[], opis }[], nastepne_odjazdy[], komunikat, zrodlo }` – rozkład ZTP Kraków (GTFS), najbliższe 90 min, bez lub z jedną przesiadką |
| POST | `/halohub/tools/polec_miejsca` | narzędzie agenta; body `{ kategoria, gdzie?, kuchnia?, dla_wozka? }` → `{ miejsce_odniesienia, miejsca: { nazwa, rodzaj, kuchnia, adres, odleglosc_m, godziny, dla_wozka, strona, telefon, ocena, opinie, ranking, cena, zrodlo, najblizszy_przystanek }[], wycieczki: { tytul, ocena, opinie, cena_od, czas, url }[], zrodla, komunikat }`; kategorie: restauracja, kawiarnia, bar, szybkie_jedzenie, lody, atrakcja, muzeum, park, punkt_widokowy, toaleta, apteka, bankomat, kantor, informacja_turystyczna, sklep_spozywczy, wycieczka. Źródła: OpenStreetMap; Tripadvisor (`TRIPADVISOR_API_KEY`) i Viator (`VIATOR_API_KEY`), gdy ustawione |
| GET | `/halohub/public/rops/szukaj?q=&zrodla=biblioteka,raporty&kategorie=A&kategorie=B&grupa=&limit=&offset=` | wyszukiwarka asystenta ROPS (kategorie: powtórzony parametr albo `|`, bo nazwy zawierają przecinki); `razem` przy zapytaniu = liczba pobranych trafień |
| POST | `/halohub/public/rops/zapytaj` | `{ pytanie, historia? }` → `{ odpowiedz, zrodla, model }` |
| POST | `/halohub/public/rops/pomysly` | kreator pomysłów: fiszka `{ typ: 'pomysl' \| 'dobra_praktyka', tytul, opis, istota, dla_kogo?, odbiorcy?: string[], etap: 'pomysl' \| 'prototyp' \| 'testy' \| 'wdrozone', kontakt?: { nazwa?, email }, zgoda?, jezyk? }` → `201 { id, numer, status: 'nowy' }`; wymagane `dla_kogo` albo `odbiorcy`; `kontakt` tylko ze `zgoda: true`; limit `ROPS_IDEA_LIMIT` (domyślnie 10) zgłoszeń na IP / 10 min |
| POST | `/halohub/public/rops/kreator/asystent` | asystent kreatora: `{ krok: 'opis' \| 'istota' \| 'dla_kogo', szkic, pytanie?, jezyk? }` → `{ wskazowka, propozycja, podobne: WynikRops[], model }`; bez LLM `wskazowka`, `propozycja` i `model` są `null`, a `podobne` (Biblioteka Innowacji) nadal wracają |
| GET | `/halohub/api/pomysly?limit=` | Bearer admin; fiszki od najnowszej, bez danych kontaktowych (`ma_kontakt: boolean`) |
| POST | `/halohub/tools/zapisz_postep` | narzędzie agenta; body `{ caller_id, conversation_id?, cel?, ostatni_krok?, podsumowanie?, typ_uzytkownika?, jezyk?, czy_dotarl? }` → `{ ok }` – zapis postępu w trakcie rozmowy (scalany z kontekstem), żeby po zerwaniu połączenia od razu kontynuować; `znajdz_polaczenie` z `caller_id` zapisuje zaplanowany przejazd sam |
| POST | `/halohub/tools/kontekst_rozmowy` | narzędzie agenta; body `{ caller_id, decyzja: 'kontynuacja' \| 'nowa_sprawa' }` – `nowa_sprawa` usuwa zapisany kontekst dzwoniącego |

## Typy

```ts
type Kategoria = 'BARIERA_FIZYCZNA' | 'AWARIA' | 'OZNAKOWANIE' | 'KOMUNIKACJA_MIEJSKA' | 'JEZYK'
  | 'INFORMACJA' | 'ODPOCZYNEK_I_TOALETY' | 'BEZPIECZENSTWO' | 'ORIENTACJA' | 'INNE';
type TypUzytkownika = 'senior' | 'wozek' | 'chodzik' | 'wozek_dzieciecy' | 'bagaz'
  | 'obcokrajowiec' | 'nowy_w_miescie' | 'inny';
type Status = 'nowy' | 'w_analizie' | 'zaplanowany' | 'naprawiony' | 'odrzucony';
type Priorytet = 'P1' | 'P2' | 'P3';
type Podzial = Record<string, number>;         // brak wartości liczony jako "nieznany"
type Udzial = number | null;                    // 0–1

interface Metryki {
  okres_od: string; okres_do: string; jezyk: string | null; wersja_definicji: string;
  demo: boolean;                                 // true → podpis „dane przykładowe”
  rozmowy: { razem: number; wg_jezyka: Podzial; wg_typu: Podzial; wg_dnia: { dzien: string; liczba: number }[] };
  mediana_czasu_s: { razem: number | null; wg_jezyka: Record<string, number | null> };
  odsetek_dotarlo: { razem: Udzial; wg_jezyka: Record<string, Udzial>; wg_typu: Record<string, Udzial> };
  ponowne_telefony: { razem: Udzial; wg_jezyka: Record<string, Udzial> };
  bariery: { razem: number; wg_kategorii: Podzial; wg_dzielnicy: Podzial; wg_powagi: Podzial;
             wg_jezyka: Podzial; wg_dnia: { dzien: string; liczba: number }[] };
  udzial_grup_wrazliwych: Udzial;
  tematy_p1: { razem: number; wg_kategorii: Podzial; wg_dzielnicy: Podzial };   // otwarte teraz
  tematy_p2: { razem: number; wg_kategorii: Podzial; wg_dzielnicy: Podzial };
  czas_reakcji_dni: { razem: number | null; wg_priorytetu: Record<Priorytet, number | null> };
  naprawione: { razem: number; wg_kategorii: Podzial };
  bariery_jezykowe: { razem: number; wg_jezyka: Podzial };
  luka_jezykowa_dotarcia: number | null;         // punkty procentowe: PL − inne języki
  pytania_rag: { razem: number; wg_grupy: Podzial; wg_jezyka: Podzial };
  odsetek_bez_wynikow: { razem: Udzial; wg_grupy: Record<string, Udzial> };
}

interface Innowacja { tytul: string; url: string; glos_streszczenie: string | null; kontakt: string | null; zrodlo: string }

interface Temat {
  id: string; klucz: string; tytul: string; kategoria: Kategoria; miejsce: string; dzielnica: string | null;
  liczba_zgloszen: number; liczba_osob: number; sr_powaga: number; grupy: string[]; jezyki: string[];
  trend_7d: number;                              // zgłoszenia 7 dni / poprzednie 7 dni
  wynik: number; priorytet: Priorytet;
  rozbicie: string;                              // np. "3 zgłoszenia × powaga 3 × wózek …"
  status: Status; notatka: string | null; historia: { status: Status; kiedy: string }[];
  innowacje: Innowacja[];
  pierwsze_zgloszenie: string; ostatnie_zgloszenie: string; aktywny: boolean; demo: boolean; zaktualizowano: string;
}

interface Bariera {
  id: string; kategoria: Kategoria; opis: string; miejsce: string; dzielnica: string | null;
  powaga: 1 | 2 | 3; dotyczy: string[]; jezyk: string | null; typ_uzytkownika: string | null;
  demo: boolean; utworzono: string;
}

interface RozmowaSkrot {
  id: string; conversation_id: string; typ_uzytkownika: string | null; jezyk: string | null;
  cel_podrozy: string | null; czy_dotarl: boolean | null; czas_trwania_s: number | null;
  czy_powrot: boolean; liczba_barier: number; demo: boolean; utworzono: string;
}

interface Luki {
  pytania_bez_wynikow: { pytanie: string; liczba: number; grupy: string[]; jezyki: string[]; ostatnio: string }[];
  potrzeby_nieznalezione: { temat: string; liczba: number; grupy: string[] }[];
  polecane: { url: string; tytul: string | null; liczba: number }[];
  ingest: {
    ostatni: { id: string; start: string; koniec: string | null; status: 'trwa' | 'ok' | 'blad';
               statystyki: Record<string, number>; bledy: string[] } | null;
    korpus: { documents: number; chunks: number; embeddedChunks: number;
              sources: { source: string; active: number; inactive: number }[]; lastFetchedAt: string | null };
  };
}

interface Pipeline {
  scheduler: { enabled: boolean; report_hour: number; auto_ingest: boolean };
  etapy: { id: 'ingest' | 'embedding' | 'rozmowy' | 'tematy' | 'raport' | 'publikacja';
           status: 'ok' | 'blad' | 'trwa' | 'brak' | 'ostrzezenie';
           ostatnio: string | null; nastepny: string | null;      // nastepny: null bez harmonogramu
           metryki: Record<string, number | string | null> }[];
  // ingest: dokumenty, zrodla, bledy, czas_s · embedding: fragmenty, z_embeddingiem, procent, model
  // rozmowy: rozmowy_24h, bariery_24h, pytania_rag_24h · tematy: aktywne, p1, p2, p3
  // raport: raporty, zrodlo · publikacja: szkice, opublikowane
  ingest_historia: { id: string; start: string; koniec: string | null; status: 'trwa' | 'ok' | 'blad';
                     statystyki: Record<string, number>; bledy: string[] }[];   // najnowsze pierwsze, max 20
}

interface TematPubliczny {
  tytul: string; kategoria: Kategoria; miejsce: string; dzielnica: string | null; liczba_zgloszen: number;
  priorytet: Priorytet; status: Status; wynik: number; grupy: string[]; jezyki: string[];
}

interface PublikacjaSkrot {
  id: string; okres_od: string; okres_do: string; status: 'szkic' | 'opublikowana';
  opublikowano: string | null; utworzono: string; demo: boolean; liczba_tematow: number;
}

interface Publikacja extends PublikacjaSkrot {
  wersja_definicji: string;
  metryki: Metryki;
  tematy: TematPubliczny[];                      // tylko tematy zgłoszone przez >= PUBLIC_MIN_ZGLOSZEN różnych osób
  raport_md: string | null;                      // w języku z ?lang
  jezyki_raportu: string[];                      // dostępne tłumaczenia
}
```
