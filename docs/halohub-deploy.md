# Halo, Hub! – wdrożenie (Coolify + ElevenLabs)

Backend (`universal-backend`) i frontend (`polish-stonks-bot/web`) to dwie aplikacje w Coolify,
plus jedna baza MongoDB. RAG, kontekst rozmów i cache są w MongoDB, więc Redis nie jest potrzebny.

## 1. MongoDB

1. Projekt → **+ New** → **Database** → **MongoDB** (obraz `mongo:8` lub domyślny).
2. Nie włączaj „Make it publicly available” (backend łączy się po sieci wewnętrznej).
3. **Start**, potem skopiuj **Mongo URL (internal)**, np.
   `mongodb://root:<hasło>@<uuid>:27017/?directConnection=true`.
4. Włącz **Backups** (zakładka Backups, np. codziennie).

## 2. Backend (istniejąca aplikacja universal-backend)

**Environment Variables** – dodaj (wartości sekretów wygeneruj: `openssl rand -hex 32`):

| Zmienna | Wartość |
|---|---|
| `MONGODB_URI` | Mongo URL (internal) z kroku 1 |
| `MONGODB_DB` | `universal` |
| `GEMINI_API_KEY` | klucz z aistudio.google.com (już jest dla escrow) |
| `DATA_DIR` | `/app/data` |
| `HALOHUB_ADMIN_TOKEN` | sekret (ten sam w frontendzie) |
| `HALOHUB_CRON_SECRET` | sekret |
| `HALOHUB_TOOL_SECRET` | sekret (wpisz w narzędziu ElevenLabs) |
| `HALOHUB_INIT_SECRET` | sekret (webhook inicjacji) |
| `ELEVENLABS_WEBHOOK_SECRET` | sekret HMAC z ElevenLabs (krok 4) |
| `ELEVENLABS_AGENT_ID` | id agenta (widget na stronie publicznej) |
| `PHONE_HASH_SALT` | sekret – **nie zmieniaj po starcie**, inaczej kontekst i liczenie osób się rozjadą |
| `INBOUND_NUMBER` | `+420910923449` |
| `HALOHUB_SCHEDULER` | `true` |
| `RAG_API_KEY` | sekret (opcjonalnie, generyczne `/rag`) |
| `AUTO_PUBLISH` | `false` (na demo może być `true`) |

**Persistent Storage** – jeśli jeszcze nie ma: **+ Add** → Volume, destination `/app/data`
(escrow SQLite + cache ingestu).

**Deploy**. Po starcie sprawdź: `GET https://<backend>/halohub/public/info`.

### Pierwszy ingest RAG

Po deployu harmonogram sam uruchomi ingest (po ok. 30 s, potem co tydzień). Ręcznie:

- Coolify → aplikacja → **Terminal**: `node dist/halohub/cli.js ingest` (pełny, ok. 10–20 min
  przez limit 1 żądanie/s i limity darmowego Gemini), albo
- `curl -X POST https://<backend>/halohub/jobs/ingest -H "x-cron-secret: $HALOHUB_CRON_SECRET"`.

Stan: `GET /halohub/api/wiedza/luki` (pole `ingest`) albo zakładka „Wiedza” w panelu.

### Zamiast wbudowanego harmonogramu (opcjonalnie)

Gdyby backend miał kiedyś więcej niż jedną instancję: `HALOHUB_SCHEDULER=false` i w zakładce
**Scheduled Tasks** aplikacji:

| Nazwa | Command | Frequency |
|---|---|---|
| tematy | `node dist/halohub/cli.js topics` | `0 * * * *` |
| raport | `node dist/halohub/cli.js report` | `0 5 * * *` (UTC) |
| ingest | `node dist/halohub/cli.js ingest` | `0 3 * * 1` |

## 3. Frontend (`polish-stonks-bot/web`)

1. **+ New** → **Application** → repo `carrotly-technologies-2026/polish-stonks-bot`, branch,
   **Base Directory** `/web`, **Build Pack** `Dockerfile`, port `3000`.
2. Environment Variables: `HALOHUB_API_URL` = wewnętrzny lub publiczny URL backendu,
   `HALOHUB_ADMIN_TOKEN` = to samo co w backendzie, `PANEL_PASSWORD` = hasło do `/panel`.
3. Domena, np. `https://halohub.<twoja-domena>`, **Deploy**.

## 4. ElevenLabs

**Post-call webhook** (Agents Platform → Settings → Webhooks / Post-call webhook):
URL `https://<backend>/halohub/webhooks/elevenlabs`, typ „transcription”. Skopiuj wygenerowany
sekret HMAC do `ELEVENLABS_WEBHOOK_SECRET`.

**Webhook inicjacji** (Settings → Conversation initiation client data webhook):
URL `https://<backend>/halohub/webhooks/elevenlabs/init`, nagłówek `x-init-secret: <HALOHUB_INIT_SECRET>`
(jeśli nie da się dodać nagłówka: `...?key=<HALOHUB_INIT_SECRET>`). W agencie: Security →
włącz „Fetch conversation initiation data” dla połączeń Twilio. Zmienne dynamiczne agenta:
`czy_powrot` (domyślnie `nie`), `poprzedni_kontekst` (domyślnie pusty).

**Narzędzie** (Agent → Tools → Add tool → Webhook):

| Pole | Wartość |
|---|---|
| Name | `szukaj_wiedzy` |
| Description | PLAN.md 7.3 |
| Method / URL | `POST https://<backend>/halohub/tools/szukaj_wiedzy` |
| Headers | `x-tool-secret: <HALOHUB_TOOL_SECRET>` (jako secret) |
| Body: `pytanie` | string, wymagane, „krótkie pytanie po polsku” |
| Body: `grupa` | string, opcjonalne, enum `senior, wozek, chodzik, wozek_dzieciecy, bagaz, obcokrajowiec, nowy_w_miescie, inny` |
| Body: `jezyk` | string, opcjonalne, „kod języka rozmowy, np. pl, uk, en” |
| Body: `conversation_id` | dynamic variable `system__conversation_id` |

**Analysis → Data collection**: pola z PLAN.md sekcja 5 (`problemy_json`, `typ_uzytkownika`,
`jezyk_rozmowy`, `cel_podrozy`, `czy_dotarl`, `kontekst_podsumowanie`, `ostatni_krok`,
`potrzeby_json`) – nazwy muszą się zgadzać 1:1.

## 5. Test po wdrożeniu

1. Panel → Publikacje → „Wczytaj dane demonstracyjne” (albo `POST /halohub/api/demo/seed`),
   potem „Wygeneruj szkic” i „Opublikuj” – strona publiczna i CSV pokazują „dane przykładowe”.
2. Zadzwoń na numer, po rozmowie w panelu pojawia się rozmowa, a po jobie tematów – temat.
3. Zadzwoń ponownie w ciągu godziny – bot kontynuuje trasę.
4. Przed prawdziwym pilotażem: Panel → usuń dane demonstracyjne.
