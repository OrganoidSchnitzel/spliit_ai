# Spliit AI 🤖

Automatically categorize your [Spliit](https://github.com/spliit-app/spliit) expenses using a local LLM via [Ollama](https://ollama.ai). Inspired by [paperless-ai](https://github.com/clusterzx/paperless-ai).

## Features

- **Word list pre-filtering** – common German merchants (Lidl, Rewe, IKEA, …) are matched
  instantly without an LLM call. Matching runs at word boundaries and understands German
  compounds in both directions (*Tankstellen*rechnung, Kleider*schrank*) and umlaut
  spellings (`möbel` = `moebel`). When two lists match a title equally well, the decision
  is handed to the LLM rather than guessed.
- **Optimized for Intel N100** – compact prompts, `keep_alive` tuned so the model is not
  re-read from disk between runs, `temperature: 0` for reproducible results, and schema-
  constrained decoding.
- **Automatic categorization** – a scheduled job scans uncategorized expenses and assigns
  the most likely category using a local Ollama model, with an escalating retry backoff so
  an expense it cannot categorize does not consume the batch forever.
- **Confidence threshold** – suggestions below the threshold are held for review.
- **Dry-run mode** – suggest and log without writing anything to Spliit.
- **Settings in the UI** – 18 settings are editable at runtime and persisted to the data
  volume; environment variables supply the defaults.
- **Customizable prompt template** – edit and preview the LLM prompt in the UI. Validated,
  and persisted across restarts.
- **Word list management** – add/remove keywords in the Settings UI, test a title against
  every list, and reset a list to its shipped state. Additions *and* removals persist.
- **Playground** – test a suggestion on a real or made-up expense, and see which keyword
  decided the outcome.
- **Dashboard** – service health, outstanding work, and inline category assignment.
- **Processing history** – every attempt is logged to SQLite, with filtering, search and
  paging. Corrections you make by hand are recorded and summarised, so you can see where
  the model is going wrong.
- **REST API** – trigger runs, get suggestions, or apply categories programmatically.
  Optional shared-secret authentication.
- **Docker-ready** – a `Dockerfile` and `docker-compose.yml` are included.
- **Unraid-ready** – see [UNRAID_SETUP.md](UNRAID_SETUP.md) for step-by-step instructions.

> See [CHANGELOG.md](CHANGELOG.md) for what changed in v1.1, and
> [ANALYSIS.md](ANALYSIS.md) for the review that drove it.

---

## Architecture

```
┌──────────────────────┐     SQL     ┌─────────────────┐
│   Spliit (Next.js)   │ ──────────► │   PostgreSQL    │
└──────────────────────┘             └────────┬────────┘
                                              │ reads/writes
                                     ┌────────▼────────┐
                                     │   Spliit AI     │  ← this service
                                     │  (Express.js)   │
                                     └────────┬────────┘
                                              │ HTTP
                                     ┌────────▼────────┐
                                     │     Ollama      │
                                     │  (local LLM)    │
                                     └─────────────────┘
```

Spliit AI connects **directly to the same PostgreSQL database** that Spliit uses. It reads uncategorized expenses, asks Ollama to suggest a category, and writes the result back — no changes to Spliit's codebase required.

---

## Quick Start

### Prerequisites

| Service | Requirement |
|---------|-------------|
| Node.js | ≥ 18 |
| PostgreSQL | Same instance used by Spliit |
| Ollama | Running locally with at least one model pulled |

### 1. Clone and install

```bash
git clone https://github.com/OrganoidSchnitzel/spliit_ai.git
cd spliit_ai
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env – set DB_HOST, DB_PASSWORD, OLLAMA_BASE_URL, OLLAMA_MODEL
```

Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | Spliit PostgreSQL host |
| `DB_NAME` | `spliit` | Database name |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | – | Database password |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API base URL |
| `OLLAMA_MODEL` | `llama3.2` | Model to use (must be pulled) |
| `CONFIDENCE_THRESHOLD` | `0.6` | Min confidence to auto-apply (0–1) |
| `SCHEDULER_ENABLED` | `true` | Enable periodic runs |
| `SCHEDULER_CRON` | `*/15 * * * *` | Cron expression for automatic runs |
| `BATCH_SIZE` | `10` | Max expenses per scheduled run |

### 3. Pull a model

```bash
ollama pull llama3.2
```

### 4. Run

```bash
npm start
# or for development with auto-restart:
npm run dev
```

Open <http://localhost:3000> in your browser.

---

## Docker Compose

The included `docker-compose.yml` runs Spliit AI as a container and expects to share a Docker network with your Spliit PostgreSQL and Ollama containers.

```bash
# Copy and edit the environment file
cp .env.example .env

# Build and start
docker compose up -d
```

**Connecting to an existing Spliit stack:** edit `docker-compose.yml` and set `networks.spliit-network.external: true` with the correct network name (e.g. `spliit_default`).

---

## Unraid Installation

For a full step-by-step guide to running Spliit AI on an Unraid server (including finding your Spliit network, building the image, volume mounts, and Ollama GPU setup), see **[UNRAID_SETUP.md](UNRAID_SETUP.md)**.

---

## API Reference

All endpoints are under `/api`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Service health (DB + Ollama + scheduler) |
| `GET` | `/api/categories` | List all Spliit categories |
| `GET` | `/api/expenses/uncategorized` | Uncategorized expenses + total outstanding |
| `POST` | `/api/expenses/:id/suggest` | Get a suggestion (no DB write) |
| `POST` | `/api/expenses/preview` | Suggest for a made-up expense that need not exist |
| `POST` | `/api/expenses/:id/apply` | Apply a category; recorded as a manual correction |
| `POST` | `/api/expenses/:id/park` | Stop retrying this expense |
| `DELETE` | `/api/expenses/:id/park` | Resume retrying it |
| `POST` | `/api/process` | Trigger a batch run (`{ force, dryRun }`) |
| `GET` | `/api/process/status` | Whether a run is in flight, and the last result |
| `GET` | `/api/history` | History (`?limit&offset&status&search`) + stats |
| `GET` | `/api/history/corrections` | Where a manual correction overrode a suggestion |
| `DELETE` | `/api/history` | Clear the log |
| `POST` | `/api/history/prune` | Apply the retention policy now |
| `GET` | `/api/settings` | Effective settings, the schema, and read-only process config |
| `PATCH` | `/api/settings` | Update settings (validated, all-or-nothing) |
| `DELETE` | `/api/settings/:key` | Revert one setting to its environment default |
| `DELETE` | `/api/settings` | Revert every setting |
| `GET` | `/api/models` | Models Ollama has pulled, plus recommendations |
| `GET` | `/api/wordlists` | All word lists, annotated with your edits |
| `POST` | `/api/wordlists/test` | Explain what a title would match |
| `POST` | `/api/wordlists/:listName/keywords` | Add a keyword |
| `DELETE` | `/api/wordlists/:listName/keywords/:keyword` | Remove a keyword |
| `POST` | `/api/wordlists/:listName/reset` | Restore a list's shipped keywords (`all` for every list) |
| `GET` | `/api/prompt/template` | Current prompt template |
| `POST` | `/api/prompt/template` | Update it (validated, persisted) |
| `POST` | `/api/prompt/preview` | Render a template against a sample expense |
| `DELETE` | `/api/prompt/template` | Reset to the built-in prompt |

When `API_TOKEN` is set, every endpoint except `/api/health` requires
`X-Api-Token: <token>` or `Authorization: Bearer <token>`.

### Example: get a suggestion

```bash
curl -X POST http://localhost:3000/api/expenses/<expense-id>/suggest
```

```json
{
  "expense": { "id": "...", "title": "Lidl", "amount": 4250 },
  "suggestion": {
    "categoryId": 1,
    "categoryName": "Groceries",
    "confidence": 0.92,
    "reasoning": "The title 'Lidl' refers to a grocery store chain."
  },
  "meetsThreshold": true
}
```

### Example: apply a category

```bash
curl -X POST http://localhost:3000/api/expenses/<expense-id>/apply \
  -H "Content-Type: application/json" \
  -d '{"categoryId": 1}'
```

---

## Development

```bash
# Run tests
npm test

# Start with auto-reload
npm run dev
```

Tests use [Jest](https://jestjs.io/) with all external services mocked (no live database or Ollama required).

---

## How it works

1. **Scheduler** fires according to `SCHEDULER_CRON` (default every 15 minutes). A run
   will not start while another is still going.
2. **categorizationService** queries for expenses with `categoryId = 0`, excluding parked
   ones, then filters to those actually *due*: an expense that has already been attempted
   waits out an escalating backoff (`RETRY_BACKOFF_HOURS`, default 1h → 6h → 24h) before
   being tried again, and is parked after the last step. Without this, an expense the model
   cannot categorize is re-sent on every run forever and starves everything older than it.
3. **Word list matching** runs first, across 37 lists covering all official
   [Spliit categories](https://github.com/spliit-app/spliit/blob/main/prisma/migrations/20240108194443_add_categories/migration.sql).
   Keywords match at word boundaries; those of 5+ characters also match inside German
   compounds, and 6+ characters at the end of one. Confidence reflects match quality
   (0.80 for a short whole word up to 0.95 for a multi-word phrase). If two lists match
   equally well the result is discarded as ambiguous and the LLM decides.
4. **ollamaService** (on a word-list miss) builds a compact prompt and calls
   `/api/generate` with the response schema as `format`, so decoding is constrained to the
   contract. `keep_alive` keeps the model resident between runs; `temperature: 0` makes the
   result reproducible. Transient failures are retried with backoff.
5. The response is validated, then re-checked against the word lists: if they disagree with
   the model on an unambiguous merchant, the word list wins and the confidence drops to the
   weaker of the two.
6. If `confidence ≥ CONFIDENCE_THRESHOLD` the category is written to Spliit — unless
   `DRY_RUN` is on. Otherwise it is held for review.
7. Every attempt is recorded in the **processing history** (SQLite, `data/app.db`),
   including which source decided it and how long it took. Corrections you make by hand
   are recorded too, and surfaced in the History tab.
8. Your word-list edits live in `data/manual-keywords.json` and your settings in the same
   SQLite database, so both survive container updates when `/app/data` is mounted.

**Performance**: with word lists enabled, most common German expenses are categorized
without an LLM call at all. The History tab reports the actual split and the average LLM
latency for your setup.

---

## License

MIT
