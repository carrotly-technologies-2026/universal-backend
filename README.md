# universal-backend

Generic NestJS backend hosting several products ("domains"). Shared infrastructure lives in
generic modules; each product is a domain module under its own route prefix.

| Module | Kind | Routes | Purpose |
|---|---|---|---|
| `database/` | shared | – | MongoDB connection (`MONGODB_URI`, `MONGODB_DB`, default `universal`); lazy, so the app boots without it |
| `llm/` | shared | – | Gemini text generation + embeddings (`GEMINI_API_KEY`, free tier) |
| `request-log/` | shared | `/stats` | request logs and a password-protected stats page |
| `rag/` | generic feature | `/rag/:corpus/*` | multi-corpus RAG: chunking, Gemini embeddings, hybrid vector + full-text search (RRF) |
| `transit/` | generic feature | `/transit`, `/transit/stops?q=`, `/transit/plan?skad=&dokad=` | journey planner on GTFS feeds (`TRANSIT_GTFS_FEEDS="id=url,…"`, default Kraków trams + buses; empty disables). Loaded in memory (~0.5 GB RSS for both Kraków feeds), refreshed every 12 h, cached in `DATA_DIR/gtfs` |
| `places/` | generic feature | `/places?kategoria=&gdzie=&kuchnia=&wozek=`, `/places/providers` | restaurants, sights, toilets, pharmacies… near a stop or landmark: OpenStreetMap (Overpass + Nominatim, cached 6 h); Tripadvisor Content API (`TRIPADVISOR_API_KEY`) and Viator Partner API (`VIATOR_API_KEY`) when keys are set |
| `escrow/` | domain | `/escrows/*` | Solana escrow dApp (SQLite in `DATA_DIR`) |
| `halohub/` | domain | `/halohub/*` | "Halo, Hub!" voice guide for Kraków – see [docs/halohub-api.md](docs/halohub-api.md) |

All env variables are listed in [.env.example](.env.example).

```bash
yarn install
docker run -d --name mongo -p 27017:27017 mongo:8   # local MongoDB
cp .env.example .env                                  # then export it, or set vars in your shell
yarn start:dev
yarn test                                             # unit + MongoDB integration tests (in-memory mongod)
```

## RAG API

Generic retrieval for any client; all endpoints need `x-api-key: $RAG_API_KEY`. A corpus is any
`[a-z0-9_-]{1,40}` name; corpora share the `rag_documents` / `rag_chunks` collections.

- `POST /rag/:corpus/documents` – `{documents: [{url, title, text, source?, category?, tags?, summary?, contact?}]}`
  (max 200). Upserts by `url` (unchanged content is skipped), chunks (~800 tokens, 100 overlap,
  paragraph-aware) and embeds new chunks. Returns `{created, updated, unchanged, embeddedChunks}`.
- `POST /rag/:corpus/search` – `{query, k?, tags?, sources?}` → hits `{documentId, url, title, source,
  category, tags, summary, contact, snippet, score}`. Vector (Gemini `gemini-embedding-001`, 768 dims,
  cosine, in-process) and MongoDB `$text` rankings fused with Reciprocal Rank Fusion; without a
  Gemini key it degrades to text search. `tags` matches documents having any of the tags.
- `GET /rag/:corpus` – stats; `GET /rag/:corpus/documents?source=` – list.

Vector search runs over an in-memory copy of the corpus embeddings (reloaded when the corpus
changes), so plain MongoDB without Atlas Vector Search is enough up to ~100k chunks.

## Halo, Hub! (`/halohub`)

Backend of [polish-stonks-bot/PLAN.md](https://github.com/carrotly-technologies-2026/polish-stonks-bot):
ElevenLabs webhooks (post-call + call initiation), the `szukaj_wiedzy` RAG tool, topics and
priority score, metrics, daily LLM report, publications and open data (JSON/CSV), demo data.
Contract: [docs/halohub-api.md](docs/halohub-api.md); deployment: [docs/halohub-deploy.md](docs/halohub-deploy.md).

- Conversation context per caller (1 h) and the RAG answer cache are MongoDB collections with TTL
  indexes instead of Redis.
- Jobs run in process with `HALOHUB_SCHEDULER=true` (topics hourly, daily report after
  `HALOHUB_REPORT_HOUR` Kraków time, ingest weekly) or via `POST /halohub/jobs/*`.
- CLI (after `yarn build`): `node dist/halohub/cli.js ingest [biblioteka|raporty|mapa_wyzwan|publikacje] [--limit N]`,
  `topics`, `report`, `seed [days] [conversations]`, `unseed`.
- Ingest crawls rops.krakow.pl (Biblioteka Innowacji Społecznych with model PDFs, research reports,
  Mapa Wyzwań, publications) at 1 request/s with robots.txt, caching raw files in
  `DATA_DIR/ingest-cache`, writes a 2-sentence voice summary per library entry with Gemini and
  stores everything in the RAG corpus `halohub`. The phone tool searches only `biblioteka`
  (`HALOHUB_TOOL_SOURCES`); reports use all sources.

## Escrow API

Backend for the Solana escrow dApp (`escrow-dapp/docs/DESIGN.md`). It holds no keys and signs
nothing: it stores the item/recipient description and the seller's waybill, and runs an
advisory LLM check of the waybill. Instead of user auth, data is accepted only when its
SHA-256 matches the hash stored in the on-chain escrow account.

| Env | Default | Purpose |
|---|---|---|
| `ESCROW_PROGRAM_ID` | — (required; escrow endpoints return 503 without it) | Program that must own escrow accounts |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | JSON-RPC endpoint |
| `GEMINI_API_KEY` | — | Waybill validation (Gemini, free tier key from aistudio.google.com); without it the verdict is `unavailable` |
| `DATA_DIR` | `./data` | `escrow.db` (SQLite) and `waybills/<sha256>` files; mount a volume in production |

`:address` is the escrow account (base58, 32 bytes; 400 otherwise). Endpoints return 404 if
the account does not exist or is not an escrow owned by `ESCROW_PROGRAM_ID`.

- `GET /escrows/:address` — `{address, onChain, details, waybills}`; `onChain` is the decoded
  account (`amount`/`escrowId` as strings, hashes as hex, `statusName`), each waybill has
  `{hash, mimeType, size, uploadedAt, validation, committedOnChain}`.
- `POST /escrows/:address/details` — JSON `{itemTitle, recipientName, recipientAddress}`
  (non-empty, max 200 chars each). Fields are trimmed, then
  `sha256(itemTitle + "\n" + recipientName + "\n" + recipientAddress)` (UTF-8) must equal the
  on-chain `details_hash` (400 otherwise). **The frontend must hash the same trimmed strings.**
- `POST /escrows/:address/waybills` — multipart field `file`: PDF, JPEG or PNG (detected by
  content), max 10 MB. 409 unless the escrow is `Funded`. Returns
  `{hash, validation}`; `hash` is what the seller signs in `mark_shipped`. Re-uploading the
  same file returns the stored result.
- `GET /escrows/:address/waybills/:hash` — the waybill file.

`validation` is `{verdict: 'valid' | 'suspicious' | 'invalid', carrier, trackingNumber,
recipientName, recipientAddress, shipDate, reasons}` (nullable strings, `reasons` in Polish),
or `{verdict: 'unavailable', reasons}` when the model could not be used. It is advisory only.

