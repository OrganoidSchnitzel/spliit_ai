# Spliit AI 🤖

Automatically categorize your [Spliit](https://github.com/spliit-app/spliit) expenses using a local LLM via [Ollama](https://ollama.ai). Inspired by [paperless-ai](https://github.com/clusterzx/paperless-ai).

## Features

- **Word list pre-filtering** – common German merchants (Lidl, Rewe, IKEA, etc.) are matched instantly without LLM calls, resulting in 2-3x faster processing.
- **Optimized for Intel N100** – efficient prompt design and configurable batch processing for low-power systems with 16GB RAM.
- **Automatic categorization** – a scheduled job periodically scans uncategorized expenses and assigns the most likely category using a local Ollama model.
- **Confidence threshold** – suggestions below the configured threshold are not applied automatically, preventing low-quality assignments.
- **Customizable prompt template** – edit the LLM prompt directly in the UI to tune accuracy and performance.
- **Word list management** – add/remove keywords for fast category matching via the Settings UI.
- **Playground** – manually test AI suggestions on any expense before committing changes to the database.
- **Dashboard** – see the health of all connected services and the list of uncategorized expenses at a glance.
- **Processing history** – every categorization attempt is logged to a local SQLite database so you can audit what was applied.
- **REST API** – trigger runs, get suggestions, or apply categories programmatically.
- **Docker-ready** – a `Dockerfile` and `docker-compose.yml` are included for easy deployment alongside your existing Spliit and Ollama containers.
- **Unraid-ready** – see [UNRAID_SETUP.md](UNRAID_SETUP.md) for step-by-step instructions.

> **New in v1.0**: [Optimization Guide for Intel N100](OPTIMIZATION_GUIDE.md) with recommended LLM models and performance tips.

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
| `GET` | `/api/expenses/uncategorized` | List uncategorized expenses |
| `POST` | `/api/expenses/:id/suggest` | Get an AI suggestion (no DB write) |
| `POST` | `/api/expenses/:id/apply` | Apply a category to an expense |
| `POST` | `/api/process` | Manually trigger a batch run |
| `GET` | `/api/history` | Processing history + aggregate stats |
| `GET` | `/api/settings` | Current configuration |
| `GET` | `/api/wordlists` | Get all German word lists |
| `POST` | `/api/wordlists/:listName/keywords` | Add keyword to word list |
| `DELETE` | `/api/wordlists/:listName/keywords/:keyword` | Remove keyword from word list |
| `GET` | `/api/prompt/template` | Get current prompt template |
| `POST` | `/api/prompt/template` | Update prompt template |
| `DELETE` | `/api/prompt/template` | Reset to default prompt |

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

1. **Scheduler** fires according to `SCHEDULER_CRON` (default every 15 minutes).
2. **categorizationService** queries the database for expenses with `categoryId = 0` (uncategorized), up to `BATCH_SIZE`.
3. **Word list matching** – first checks if the expense title matches any German keywords (e.g., "Lidl" → Groceries). If matched, returns immediately with high confidence (0.95) without calling the LLM.
4. **ollamaService** (if no word list match) builds an optimized prompt containing the expense details and available categories, then calls the Ollama `/api/generate` endpoint with `format: "json"` to force structured output.
5. The response is parsed and validated. If `confidence ≥ CONFIDENCE_THRESHOLD`, the category is written to the database immediately. Otherwise, it is left for manual review via the Playground.
6. Every attempt (applied, low confidence, or error) is recorded in the **processing history** (SQLite, `data/history.db`).

**Performance**: With word lists enabled, 60-80% of common German expenses are categorized instantly without LLM calls, resulting in 2-3x faster processing.

---

## License

MIT
