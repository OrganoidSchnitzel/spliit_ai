# Repository Analysis — spliit_ai

Reviewed at `21ac875` (main) plus branch `copilot/add-manual-category-history-tab`.
Everything below was reproduced against the checked-out code, not inferred from reading alone.

> **Status: every finding in this document has been fixed.** This file is kept as
> the record of what was wrong and why the fixes look the way they do. See
> `CHANGELOG.md` for what shipped.

---

## 1. Blockers

### 1.1 The test suite is red on `main`, and CI never runs it

`npm test` → **7 failed, 48 passed**.

The `.github/workflows/docker.yml` workflow builds and pushes an image to `ghcr.io` on
**every branch push** (`branches: ["**"]`) but has no `npm ci && npm test` step. Broken code
ships to the registry unnoticed — which is exactly what happened here.

Root cause of the failures: `suggestCategory()` now consults `germanWordLists.matchWordList()`
*before* the LLM, so titles like `Lidl groceries`, `IKEA`, and `Schrank` never reach the LLM path
and the heuristic-override tests (`applyTitleSemanticGuard`, `applyFurnitureTitleOverride`) can no
longer be exercised end-to-end. Those tests were written against the pre-word-list behaviour and
were never updated when the word lists were merged.

One failure is independent test drift: `applyGroceryMerchantOverride` is asserted with the title
`Corner Store`, but `GROCERY_MERCHANT_KEYWORDS` is `['lidl','rewe','edeka','aldi','kaufland']` — the
override correctly no-ops.

**Fix:**
- Add a `test` job to the workflow and make the `build-and-push-image` job `needs: test`.
- Rework the override tests to call the override functions directly (unit level) and add
  separate integration tests that stub `matchWordList` to return `null` when the LLM path is
  under test.
- Delete or correct the `Corner Store` expectation.

### 1.2 Word-list matching uses raw substring `includes()` and auto-applies at 0.95 confidence

`matchWordList()` does `combined.includes(keyword)` with no token boundaries. Short keywords
(`bar`, `jet`, `real`, `total`, `db`, `hit`, `bp`) match inside unrelated German words. Because the
match returns `confidence: 0.95` and the default `CONFIDENCE_THRESHOLD` is `0.6`, the wrong category
is **written straight into the user's Spliit Postgres database** with no review step.

Reproduced:

| Title | Assigned | Matched on |
|---|---|---|
| `Barbecue Grillfleisch` | Liquor | `bar` |
| `Bargeld Abhebung` | Liquor | `bar` |
| `Barbier Haarschnitt` | Liquor | `bar` |
| `Jetzt Pizza` | Gas/Fuel | `jet` |
| `Cereal Kauf` | Groceries | `real` |
| `Total Ausgaben Juli` | Gas/Fuel | `total` |
| `Hotel Total` | Gas/Fuel | `total` |

**Fix:** match on word boundaries against a normalised title, the way `hasTitleKeyword()` in
`ollamaService.js` already does — that helper exists and does the right thing, it is just not used
here. Also prefer the **longest** match rather than the first hit, since `Object.entries(wordLists)`
iteration order currently decides the winner. Multi-word keywords (`deutsche bahn`, `burger king`)
need phrase matching, not per-token.

Suggested shape:

```js
const norm = (s) => String(s || '').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

function keywordHit(haystack, keyword) {
  return new RegExp(`(?:^|\\s)${escapeRegex(keyword)}(?:\\s|$)`, 'u').test(haystack);
}
```

…then collect every hit and return the one with the most characters.

### 1.3 Container cannot write `/app/data` when run as documented

The Dockerfile switches to the non-root `spliitai` user but never creates or chowns `/app/data`.
`UNRAID_SETUP.md` tells users to `mkdir -p /mnt/user/appdata/spliit-ai` as root and bind-mount
`.../data:/app/data`, so the mount arrives root-owned. Both `historyService.js`
(`new Database(data/history.db)`) and `germanWordLists.js` (`ensureDataDir()`) write there **at
module load time**, so the failure is a boot crash loop, not a degraded feature.

**Fix** in the Dockerfile, before `USER spliitai`:

```dockerfile
RUN mkdir -p /app/data && chown -R spliitai:spliitai /app/data
VOLUME /app/data
```

…and add a `chown` line to the Unraid guide for pre-existing bind mounts.

---

## 2. Efficiency

### 2.1 The scheduler re-processes the same stuck expenses forever

`getUncategorizedExpenses()` selects `WHERE "categoryId" = 0 ORDER BY "expenseDate" DESC LIMIT
$batchSize`. An expense whose confidence lands below the threshold is never applied, so it stays
`categoryId = 0` and is picked up again on the **next** run — every 15 minutes, indefinitely.

With `BATCH_SIZE=10`, eleven stuck expenses are enough to permanently starve every older
uncategorized expense: the newest ten fill the batch on every single run. On an N100 that is ~960
wasted LLM inferences per day producing zero progress, and it also floods the history table.

**Fix:** exclude expenses with a recent attempt. The history DB already has what you need:

```sql
-- pass the list of recently-attempted expense_ids from historyService
WHERE e."categoryId" = 0
  AND e."isReimbursement" = false
  AND e.id <> ALL($2::text[])
```

with an exponential backoff per expense (retry after 1h, 6h, 24h, then park it). Surface parked
expenses in the UI as "needs manual review" — which is exactly what the history-tab branch is
reaching for.

### 2.2 Ollama reloads the model from disk on every batch run

The `/api/generate` payload sets only `model`, `prompt`, `stream`, `format`. Ollama's default
`keep_alive` is 5 minutes; `SCHEDULER_CRON` defaults to `*/15`. The model is therefore evicted
between every run and re-read from disk each time. On an Intel N100 with no GPU, loading a 3B q4
model is a multi-second to tens-of-seconds cost paid once per batch, for nothing.

```js
const payload = {
  model: config.ollama.model,
  prompt,
  stream: false,
  format: OLLAMA_RESPONSE_SCHEMA,   // see 2.3
  keep_alive: config.ollama.keepAlive ?? '30m',
  options: { temperature: 0, num_predict: 200, num_ctx: 2048 },
};
```

`temperature: 0` also makes categorization reproducible, which matters for a classifier.
`num_predict` caps runaway generations that currently only stop at the 60 s timeout.

### 2.3 `OLLAMA_RESPONSE_SCHEMA` is defined but never used

It is declared at the top of `ollamaService.js` and referenced nowhere; the request sends
`format: 'json'`. PR #2 originally shipped schema-locked output and a later change reverted the
behaviour while leaving the constant behind. Passing the schema as `format` makes Ollama constrain
decoding to it, which would render most of `stripMarkdown` / `stripThinkingTags` /
`extractFirstJsonObject` / the nested-JSON re-parse unnecessary — roughly 80 lines of defensive
parsing that exists to work around a problem the library can solve directly. Keep the fallbacks for
older Ollama versions, but stop paying for them on the happy path.

### 2.4 Categories are re-fetched from Postgres on every request

`GET /api/categories`, `POST /:id/suggest`, `POST /:id/apply` and every `runBatch()` each issue
`SELECT id, grouping, name FROM "Category"`. Spliit's category table is a fixed seed list that
effectively never changes. A 5-minute in-memory TTL cache in `categorizationService` removes a
query from every single hot path, including the per-row category dropdowns the history branch adds.

### 2.5 Every query is logged at full volume

`db.query()` unconditionally `console.debug`s each statement with timing. Under the default
scheduler that is constant noise in `docker logs` with no way to turn it off. Gate it behind
`LOG_LEVEL` / `DEBUG_SQL`.

---

## 3. Reliability

### 3.1 No config validation — a German decimal comma silently disables the threshold

```
CONFIDENCE_THRESHOLD="0,7"  → parseFloat → 0      → every suggestion auto-applies
BATCH_SIZE="ten"            → parseInt   → NaN    → SQL "LIMIT NaN" → every run errors
```

Both reproduced. The first is the dangerous one: it is a plausible typo for this app's German
audience, it produces no warning, and the symptom is "the AI started categorizing everything
wrong" — days later. Validate at boot and refuse to start:

```js
function num(name, raw, { min, max, fallback }) {
  const v = Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid ${name}: "${raw}" (expected ${min}–${max})`);
  }
  return v;
}
```

### 3.2 Concurrent batch runs are not prevented

`node-cron` fires the next tick regardless of whether the previous async callback has finished, and
`POST /api/process` can be triggered from the UI at the same time. Two runs then select the *same*
uncategorized rows and both call the LLM on them. Guard with a module-level `isRunning` flag in
`categorizationService.runBatch()` and return `{ skipped: true }` to the caller.

### 3.3 Removing a built-in keyword does not survive a restart

`manual-keywords.json` records *additions* only. `removeKeyword()` deletes from the in-memory list
and, if it was manual, untracks it — but deleting a **built-in** keyword persists nothing, so it
reappears on the next boot. Given 1.2, deleting a built-in like `bar` or `jet` is precisely what a
user will want to do first. Persist a `removed` set alongside `added` and subtract it during
`loadPersistedManualKeywords()`.

### 3.4 Custom prompt templates are lost on restart

`POST /api/prompt/template` assigns to `config.ollama.customPromptTemplate` in memory. Manual
keywords are persisted; prompts are not — an inconsistency users will read as a bug. There is also
no validation that the submitted template contains `{{title}}` / `{{categories}}`, so a template
missing its placeholders silently breaks every subsequent categorization with no error anywhere.
Persist it next to `manual-keywords.json` and reject templates lacking required placeholders.

### 3.5 The history table grows without bound

`data/history.db` has no retention policy and no indexes. `SELECT * FROM history ORDER BY
processed_at DESC LIMIT ?` is a full scan plus sort. Combined with 2.1 (a row per stuck expense
every 15 minutes) this reaches six figures within a year on a homelab box.

```sql
CREATE INDEX IF NOT EXISTS idx_history_processed_at ON history(processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_expense_id   ON history(expense_id);
```

…plus a `HISTORY_RETENTION_DAYS` prune on startup. `better-sqlite3` is synchronous, so once the
table is large every history read blocks the event loop.

### 3.6 Module-level side effects make startup fragile and tests awkward

`historyService.js` opens the SQLite DB and runs DDL at `require()` time;
`germanWordLists.js` calls `loadPersistedManualKeywords()` at `require()` time, and that function
calls `fs.statSync` outside any `try`. A permissions problem or a torn file surfaces as an
unhandled throw during module resolution — before any logging is set up. Move both behind an
explicit `init()` called from `app.js`, and wrap the `statSync`.

### 3.7 Response-shape validation is stricter than it needs to be

```js
if (parsedKeys.length !== expectedKeys.length || expectedKeys.some(...)) throw ...
```

An exact key-set match means one extra key from the model (`"category"`, `"explanation"`) fails the
whole expense and records it as an `error`. Check that the required keys are *present* and ignore
extras.

### 3.8 Unknown `/api/*` routes return HTML with status 200

Verified: `GET /api/does-not-exist` → `200 text/html`, body `<!DOCTYPE html>`. The SPA catch-all
`app.get('*')` swallows API 404s, so a client typo looks like a successful response. Add a
`/api` 404 handler before the catch-all, and a JSON error middleware — a malformed request body
currently returns body-parser's default HTML error page, also verified.

### 3.9 No authentication

The app has write access to the Spliit Postgres database and exposes `POST /api/expenses/:id/apply`
and `POST /api/process` to anyone who can reach port 3000. `express-rate-limit` is not access
control. For a homelab deployment a shared-secret header or basic auth in front of `/api` would be
proportionate; at minimum the README should say the port must not be exposed beyond the LAN.

### 3.10 `esc()` does not escape single quotes, and is interpolated into an `onclick`

```js
<button onclick="playgroundFor('${esc(e.id)}')">
```

`esc()` handles `& < > "` but not `'`. Expense IDs are cuids today so this is not currently
exploitable, but it is an injection waiting for the first ID format change. Use a `data-` attribute
and a delegated listener, as the word-list UI already does.

### 3.11 Dependency vulnerabilities

`npm audit` reports 16 (8 high), mostly the pinned `axios ^1.6.7` line (SSRF via `NO_PROXY` bypass,
multiple prototype-pollution gadgets) and `body-parser <1.20.6`. `npm audit fix` resolves them
without breaking changes. Also: `npm ci --only=production` in the Dockerfile is deprecated in favour
of `--omit=dev`.

---

## 4. Evaluation — branch `copilot/add-manual-category-history-tab`

7 commits, +71/−5 across `src/public/{js/app.js,index.html,css/style.css}` and a `1.0.0 → 1.0.1`
version bump. No PR is open for it. Adds a per-row category `<select>` + Apply button to the
History tab, wired to the existing `POST /api/expenses/:id/apply`.

**The feature is the right idea.** Correcting a bad categorization from the history view is the
single most useful missing interaction in the app, and it reuses the existing endpoint rather than
adding one. The implementation is also reasonably careful: the `Promise.all` for history +
categories, the `shouldResetButton` flag so the button is not re-enabled into a table that is about
to be re-rendered, and the delegated-listener pattern in `bindHistoryActions()` are all sound. The
`colspan` was correctly updated from 7 to 8.

**But the final commit introduces a real bug.** Commit `949b68d` ("fix: use expense_id for history
action select IDs") changed:

```js
-  const selectId = `history-category-select-${row.id}`;   // history PK — unique
+  const selectId = `history-category-select-${row.expense_id}`;  // NOT unique
```

`history.id` is `INTEGER PRIMARY KEY AUTOINCREMENT` and unique per row. `expense_id` is **not**:
`recordResult()` inserts a new row for every attempt, and per 2.1 a low-confidence expense is
re-attempted every 15 minutes forever. A history view of the last 100 records will routinely contain
the same `expense_id` four, ten, or fifty times.

The consequence is that `document.getElementById(selectId)` — used in `bindHistoryActions()` —
returns the **first** element with that ID. Click Apply on the fifth row for an expense and you
apply whatever category is selected in the *first* row for that expense, which is a different
(usually stale) value. The user sees `✔ Category "X" applied` with a category they did not choose.
The `949b68d` commit moved the code from correct to incorrect; reverting that one line fixes it.

Three smaller issues:

1. **No placeholder option.** The `<select>` is built purely from categories with
   `${c.id === row.category_id ? 'selected' : ''}`. For an `error`-status row, `category_id` is
   `NULL`, so nothing is selected and the browser defaults to the first option. A user clicking
   Apply on an error row without touching the dropdown silently assigns whatever category happens to
   sort first. The guard `if (!select.value) return` can never fire, because `select.value` is always
   populated. Add a `<option value="">— pick —</option>` first.

2. **A manual correction is not recorded.** `applyHistoryCategory()` writes to Postgres and reloads,
   but nothing is written back to the history DB, so `stats` still counts the row as
   `low_confidence`/`error` and the row re-renders looking unchanged apart from a transient alert.
   More importantly, **this is the most valuable training signal the app will ever get** — the user
   explicitly stating the correct category for a title the model got wrong. It should be persisted
   (a `manual_override` status row), and ideally offered as a one-click "add `<merchant>` to the
   `<list>` word list" so corrections compound. That would turn this feature from a fixup tool into
   the app's learning loop.

3. **DOM weight.** ~44 Spliit categories × 100 history rows ≈ 4,400 `<option>` nodes rebuilt on
   every `loadHistory()`, and `loadHistory()` is called again after each Apply. On the N100 target
   this is noticeable. Render the `<select>` lazily on click, or share one `<datalist>`.

**Verdict:** worth merging after the `949b68d` revert and the placeholder-option fix — both are
one-liners. The history-recording change (point 2) is the part actually worth designing properly,
and it pairs naturally with the backoff work in 2.1.

---

## 5. Other observations

- **PR #6 (`copilot/optimize-app-for-intel-n100`, open draft) overlaps heavily with merged work.**
  It implements deterministic merchant rules backed by a SQLite `settings` table plus a persisted
  prompt template — i.e. a second, more durable version of what `germanWordLists.js` and the
  in-memory prompt override now do. Its persistence model is better than what landed (it solves
  3.3 and 3.4 as a side effect). Decide between the two rather than leaving both; do not merge as-is
  on top of the current word lists.
- **`dummy` file** (23 bytes, root) appears to be leftover CI scratch — two commits exist solely to
  touch it. Delete it.
- **No linter or formatter.** `eslint` + `prettier` with a `lint` script, wired into the same CI job
  as the tests, would have caught the unused `OLLAMA_RESPONSE_SCHEMA` (2.3) and the dead
  `if (!select.value)` branch (§4.1).
- **Four overlapping top-level docs** (`README`, `INTEGRATION_GUIDE`, `OPTIMIZATION_GUIDE`,
  `QUICK_REFERENCE`, `UNRAID_SETUP` — ~48 KB) already disagree in places. Consolidate into
  `README` + `docs/`.
- **The heuristic override layer in `ollamaService.js`** (`applyGroceryMerchantOverride`,
  `applyFurnitureTitleOverride`, `applyTitleSemanticGuard`, ~180 lines) duplicates in code what the
  word lists express as data — and since the word lists run *first*, the grocery and furniture
  overrides are now largely unreachable for the exact merchants they name. Fold them into the word
  list mechanism and delete the duplicated logic.

---

## Suggested order of work

1. CI runs tests; fix the 7 failures (1.1)
2. Word-boundary matching in `matchWordList` (1.2)
3. Dockerfile `/app/data` ownership (1.3)
4. Config validation at boot (3.1)
5. Per-expense backoff so the scheduler makes progress (2.1)
6. `keep_alive` + `options` + schema-locked `format` on the Ollama call (2.2, 2.3)
7. Revert `949b68d` and add the placeholder option, then merge the history-tab branch (§4)
8. Record manual overrides into history and feed them back into the word lists (§4.2)

Items 1–4 are each under an hour. 5 and 8 are the ones that change how well the product actually
works.
