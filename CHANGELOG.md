# Changelog

## 1.1.0

Fixes every finding in `ANALYSIS.md`, plus a rebuilt UI.

### Fixed — correctness

- **Word-list matching no longer matches substrings.** `combined.includes(keyword)`
  matched `bar` inside *Bargeld*, `jet` inside *Jetzt*, `real` inside *Cereal* and
  `total` inside *Hotel Total*, then auto-applied the result at 0.95 confidence —
  writing wrong categories straight into the Spliit database. Matching now runs at
  token boundaries, with German compounds handled in both directions
  (*Tankstellen*rechnung and Kleider*schrank*), umlaut folding so `möbel` and
  `moebel` are one keyword, longest-match-wins scoring, and an explicit tie-break
  that hands genuinely ambiguous titles to the LLM instead of guessing.
- **Configuration is validated at startup.** `CONFIDENCE_THRESHOLD=0,7` used to
  parse as `0`, silently auto-applying every suggestion; `BATCH_SIZE=ten` produced
  `LIMIT NaN`. Values are now range-checked, a decimal comma is accepted, and every
  problem is reported at once instead of one per restart.
- **The scheduler makes progress.** An expense that never cleared the confidence
  threshold stayed at `categoryId = 0` and was re-sent to the LLM every 15 minutes
  forever; eleven such expenses permanently starved everything older. Attempts now
  back off (1h, 6h, 24h by default) and are parked after the last step.
- **Concurrent batch runs are prevented.** The cron tick and the UI's Run button
  could previously process the same rows at the same time.
- **Removing a built-in keyword persists.** Only additions were saved, so deleting
  a bad built-in like `bar` brought it back on the next restart.
- **Custom prompt templates persist and are validated.** They lived in memory only,
  and a template missing its placeholders was accepted and then silently broke every
  categorization.
- **`scheduler.reload()` no longer starts a scheduler that was never running.**
  Reverting an unrelated setting could spin up a cron task in a process that
  deliberately had none.

### Fixed — deployment

- **The container can write `/app/data`.** The Dockerfile switched to a non-root
  user without creating or chowning the data directory, so the bind mount described
  in `UNRAID_SETUP.md` arrived root-owned and the app crash-looped at startup.
- **CI runs the tests.** The workflow published images to `ghcr.io` on every branch
  push without ever running `npm test` — and the suite was red. The build now
  depends on a lint + test job, and pull requests are validated without publishing.
- **Dependency vulnerabilities resolved** (16 → 0), including 8 high-severity axios
  advisories. `--only=production` replaced with `--omit=dev`.

### Fixed — API

- Unknown `/api/*` routes returned the SPA shell with a 200; they now return JSON 404s.
- A malformed JSON body returned body-parser's HTML error page; there is now a JSON
  error middleware.
- `/api/health` no longer reports `ok` when Ollama is reachable but the configured
  model is not pulled — the most common cause of "every expense errors".
- Optional shared-secret authentication via `API_TOKEN`.

### Faster

- `keep_alive` now defaults to 30m. Ollama's own default is 5m, shorter than the
  15m schedule, so the model was evicted and re-read from disk before *every* batch —
  the dominant cost on a CPU-only box.
- Ollama requests set `temperature: 0` (making categorization reproducible),
  `num_predict` (capping runaway generations that previously only stopped at the
  timeout) and `num_ctx`.
- `format` now carries the response schema, so decoding is constrained to the
  contract rather than to "some JSON".
- Categories are cached for 5 minutes instead of being re-queried on every request.
- History has indexes on `processed_at`, `expense_id` and `status`, plus a retention
  policy — the table was previously an unbounded full scan.
- SQL logging is gated behind `LOG_LEVEL=debug`; slow queries are still surfaced.
- Transient Ollama failures are retried with backoff.

### Added

- **Runtime settings.** 18 settings are editable from the UI and persisted to the
  data volume; environment variables supply the defaults. Includes a **dry-run mode**
  that suggests and logs without writing to Spliit.
- **Manual corrections are recorded.** Applying a category by hand is written to the
  history log as a correction and surfaced in a "Corrections you have made" panel —
  previously the single most valuable accuracy signal in the app was discarded.
- **Word-list tester** and **prompt preview** in Settings.
- **Model picker** showing what Ollama actually has pulled, flagging a configured
  model that is missing.
- **Playground accepts made-up expenses**, so a title can be tested before the
  expense exists, and explains which keyword decided the outcome.
- **Park / resume** controls for expenses that should stop being retried.
- History filtering, search and pagination.
- `eslint` configuration and a `lint` script.

### UI

- Rebuilt with dark mode (system-aware plus a manual toggle), toast notifications,
  a responsive layout that works at phone width, keyboard-accessible controls,
  loading and empty states, and no inline event handlers.
- `esc()` now escapes single quotes; expense IDs are passed via `data-` attributes
  and delegated listeners rather than interpolated into `onclick`.

### From `copilot/add-manual-category-history-tab`

That branch's feature — correcting a category from the History tab — is included,
with its bugs fixed:

- Its final commit (`949b68d`) switched select element IDs from the unique
  `history.id` to the **non-unique** `expense_id`. Since a row is written per
  attempt, the same expense routinely appears many times, so
  `document.getElementById()` returned the first match and Apply used a different
  row's selection. Rows now find their own `<select>` by DOM position.
- A missing placeholder option meant the browser pre-selected the first category,
  so Apply on an error row silently assigned it. There is now a `— pick a category —`
  placeholder and an explicit guard.
- The correction is now recorded in the history log rather than discarded.
