# Changelog

## 1.1.0

Fixes every finding in `ANALYSIS.md`, plus a rebuilt UI.

### Fixed — correctness

- **Word-list matching no longer matches substrings.** `combined.includes(keyword)`
  matched `bar` inside _Bargeld_, `jet` inside _Jetzt_, `real` inside _Cereal_ and
  `total` inside _Hotel Total_, then auto-applied the result at 0.95 confidence —
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
  15m schedule, so the model was evicted and re-read from disk before _every_ batch —
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

## 1.1.1

Fixes two ways 1.1.0 stopped an existing container from starting, with no
configuration change on the user's side. Both were regressions introduced by
1.1.0 itself.

- **An empty environment variable no longer aborts startup.** 1.1.0 added config
  validation, but Docker UIs — Unraid's template editor in particular — pass
  unset optional fields as empty strings rather than omitting them. `PORT=""`
  therefore reached the number parser and failed with `"" is not a number` for a
  field the user had never filled in. Empty and whitespace-only values are now
  treated as unset and fall back to their defaults; genuinely wrong values are
  still rejected.
- **The container no longer pins a uid.** 1.1.0 switched the runtime user from
  an auto-assigned system uid to `node` (uid 1000). Any bind-mounted data
  directory whose ownership matched the old uid became unwritable, and the app
  exits when it cannot write there. The image now starts as root, makes
  `/app/data` writable by `PUID:PGID` (default `99:100`, Unraid's
  `nobody:users`), then drops to that user — so the running process is still
  unprivileged, but the container works against whatever owns the host
  directory. Set `PUID`/`PGID` if yours differ.
- **Upgrading can no longer fail on the database rename.** Adopting a pre-1.1
  `history.db` as `app.db` needs write permission on the directory; if that
  fails the app now logs a warning and keeps using the existing file instead of
  refusing to boot.

## 1.1.2

Closes the remaining items from `ANALYSIS.md` that 1.1.0 left open, plus a new
advisory that landed since.

- **Row category pickers populate lazily.** Spliit ships 44 categories, so a
  100-row history page was building 4,400 `<option>` nodes on every render —
  and the table re-renders after every Apply. A row now carries only its
  placeholder (and its current category, if it has one) until the select is
  actually opened. Measured on a 13-row page: 25 nodes instead of 585.
- **`X-Forwarded-For` is no longer trusted by default.** 1.1.0 set
  `trust proxy: 1` unconditionally so the rate limiter could see real client
  IPs behind a reverse proxy. On a directly-exposed port that is backwards: any
  client can set the header and claim any address, walking past the limiter.
  It is now opt-in via `TRUST_PROXY` (a hop count, `loopback`, or a subnet).
- **`proxy-addr` critical advisory patched** (IP spoofing via IPv4-mapped IPv6
  trust subnets, GHSA-jqcg-44mw-7w3h) by moving to Express 4.22.3. Back to zero
  known vulnerabilities.
- **Documentation consolidated.** `docs/unraid.md` and `docs/optimization.md`
  are the current guides, indexed from the README. `INTEGRATION_GUIDE.md` and
  `QUICK_REFERENCE.md` are deleted: both were written before the app existed and
  still documented the multi-provider OpenAI architecture (`aiServiceFactory`,
  `AI_PROVIDER`, `OPENAI_API_KEY`) removed in #1, so they described a codebase
  that had not existed for months. Git history retains them if ever needed.
  `docs/optimization.md` is corrected too — it still claimed a flat 0.95
  word-list confidence, which stopped being true in 1.1.
- **Prettier added** alongside ESLint, and wired into `npm run lint` so CI
  checks formatting. The reformat is a separate commit.
