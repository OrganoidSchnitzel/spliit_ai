'use strict';

const express = require('express');
const { version } = require('../../package.json');
const db = require('../db');
const ollamaService = require('../services/ollamaService');
const categorizationService = require('../services/categorizationService');
const historyService = require('../services/historyService');
const germanWordLists = require('../data/germanWordLists');
const settingsStore = require('../settingsStore');
const scheduler = require('../scheduler');
const config = require('../config');

const router = express.Router();

/**
 * Wrap an async handler so a rejected promise reaches the error middleware
 * instead of hanging the request. Every route below used to repeat the same
 * try/catch to do this.
 */
const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

/** Throw a 4xx that the error middleware will render as JSON. */
function fail(status, message) {
  throw Object.assign(new Error(message), { statusCode: status });
}

function parseIntParam(raw, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

// ─── Health ────────────────────────────────────────────────────────────────────

router.get(
  '/health',
  wrap(async (_req, res) => {
    const [dbResult, ollamaStatus] = await Promise.allSettled([
      db.healthCheck(),
      ollamaService.healthCheck(),
    ]);

    const dbOk = dbResult.status === 'fulfilled' && dbResult.value === true;
    const ollama =
      ollamaStatus.status === 'fulfilled'
        ? ollamaStatus.value
        : { ok: false, models: [], error: ollamaStatus.reason.message };

    // A reachable Ollama that does not have the configured model pulled is
    // still a broken deployment, so it does not count as "ok".
    const ollamaUsable = ollama.ok && ollama.modelAvailable !== false;

    res.json({
      status: dbOk && ollamaUsable ? 'ok' : 'degraded',
      database: {
        ok: dbOk,
        error: dbResult.status === 'rejected' ? dbResult.reason.message : undefined,
      },
      ollama,
      scheduler: scheduler.status(),
      dryRun: settingsStore.get('dryRun'),
      appVersion: version,
    });
  })
);

// ─── Categories ────────────────────────────────────────────────────────────────

router.get(
  '/categories',
  wrap(async (req, res) => {
    const categories = await categorizationService.getCategories({
      force: req.query.refresh === 'true',
    });
    res.json({ categories });
  })
);

// ─── Expenses ──────────────────────────────────────────────────────────────────

/**
 * GET /api/expenses/uncategorized
 * Uncategorized expenses, with the total outstanding count so the dashboard
 * can distinguish "12 left" from "12 shown, 400 left".
 */
router.get(
  '/expenses/uncategorized',
  wrap(async (req, res) => {
    const limit = parseIntParam(req.query.limit, settingsStore.get('processing.batchSize'), {
      min: 1,
      max: 500,
    });
    const [expenses, total] = await Promise.all([
      categorizationService.getUncategorizedExpenses({ limit }),
      categorizationService.countUncategorized(),
    ]);
    res.json({ expenses, total, shown: expenses.length });
  })
);

/**
 * POST /api/expenses/:id/suggest
 * Ask for a suggestion WITHOUT applying it. Used by the playground.
 * Body: { skipWordLists?: boolean }
 */
router.post(
  '/expenses/:id/suggest',
  wrap(async (req, res) => {
    const { id } = req.params;
    const [expense, categories] = await Promise.all([
      categorizationService.getExpenseById(id),
      categorizationService.getCategories(),
    ]);

    if (!expense) fail(404, `Expense ${id} not found`);
    if (categories.length === 0) fail(400, 'No categories found in database');

    const suggestion = await ollamaService.suggestCategory(expense, categories, {
      skipWordLists: req.body && req.body.skipWordLists === true,
    });

    res.json({
      expense: {
        id: expense.id,
        title: expense.title,
        amount: expense.amount,
        currency: expense.currency,
        notes: expense.notes,
      },
      suggestion,
      wordListExplanation: germanWordLists.explain(expense, categories),
      meetsThreshold: suggestion.confidence >= settingsStore.get('confidenceThreshold'),
      threshold: settingsStore.get('confidenceThreshold'),
    });
  })
);

/**
 * POST /api/expenses/preview
 * Same as /suggest but for a hypothetical expense that need not exist in
 * Spliit — lets the playground test a title before the expense is created.
 */
router.post(
  '/expenses/preview',
  wrap(async (req, res) => {
    const { title, amount, notes, currency, skipWordLists } = req.body || {};
    if (!title || typeof title !== 'string' || !title.trim()) {
      fail(400, 'title is required');
    }

    const categories = await categorizationService.getCategories();
    if (categories.length === 0) fail(400, 'No categories found in database');

    const expense = {
      title: title.trim(),
      amount: parseIntParam(amount, 0, { min: 0 }),
      notes: typeof notes === 'string' ? notes : '',
      currency: typeof currency === 'string' ? currency : undefined,
    };

    const suggestion = await ollamaService.suggestCategory(expense, categories, {
      skipWordLists: skipWordLists === true,
    });

    res.json({
      expense,
      suggestion,
      wordListExplanation: germanWordLists.explain(expense, categories),
      meetsThreshold: suggestion.confidence >= settingsStore.get('confidenceThreshold'),
      threshold: settingsStore.get('confidenceThreshold'),
    });
  })
);

/**
 * POST /api/expenses/:id/apply
 * Apply a category chosen by hand. Recorded in history as a manual correction.
 */
router.post(
  '/expenses/:id/apply',
  wrap(async (req, res) => {
    const { id } = req.params;
    const { categoryId, note } = req.body || {};

    const numericId = Number(categoryId);
    if (categoryId === undefined || categoryId === null || !Number.isInteger(numericId)) {
      fail(400, 'categoryId must be an integer');
    }

    const [expense, categories] = await Promise.all([
      categorizationService.getExpenseById(id),
      categorizationService.getCategories(),
    ]);

    if (!expense) fail(404, `Expense ${id} not found`);

    const category = categories.find((c) => c.id === numericId);
    if (!category) fail(400, `Category ${categoryId} does not exist`);

    const result = await categorizationService.applyManualCategory(expense, category, { note });
    res.json({ ok: true, ...result });
  })
);

/**
 * POST /api/expenses/:id/park  — stop retrying this expense
 * DELETE /api/expenses/:id/park — resume retrying it
 */
router.post('/expenses/:id/park', (req, res) => {
  const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason : null;
  historyService.parkExpense(req.params.id, reason || 'Parked from the UI.');
  res.json({ ok: true, expenseId: req.params.id, parked: true });
});

router.delete('/expenses/:id/park', (req, res) => {
  const changed = historyService.unparkExpense(req.params.id);
  res.json({ ok: true, expenseId: req.params.id, parked: false, changed });
});

// ─── Batch processing ──────────────────────────────────────────────────────────

/**
 * POST /api/process
 * Trigger a batch run. Body: { force?: boolean, dryRun?: boolean }
 * `force` ignores the retry backoff.
 */
router.post(
  '/process',
  wrap(async (req, res) => {
    const body = req.body || {};
    const stats = await categorizationService.runBatch({
      force: body.force === true,
      dryRun: body.dryRun === true ? true : undefined,
    });
    if (stats.skipped) {
      return res.status(409).json({ ok: false, error: 'A batch run is already in progress', stats });
    }
    res.json({ ok: true, stats });
  })
);

/** GET /api/process/status — is a run in flight, and how did the last one go? */
router.get('/process/status', (_req, res) => {
  res.json({
    running: categorizationService.isRunning(),
    lastRun: categorizationService.getLastRunSummary(),
  });
});

// ─── History ───────────────────────────────────────────────────────────────────

/**
 * GET /api/history?limit=&offset=&status=&search=
 */
router.get('/history', (req, res) => {
  const limit = parseIntParam(req.query.limit, 50, { min: 1, max: 500 });
  const offset = parseIntParam(req.query.offset, 0, { min: 0 });
  const { rows, total } = historyService.getHistory({
    limit,
    offset,
    status: req.query.status,
    search: req.query.search,
  });
  res.json({ history: rows, total, limit, offset, stats: historyService.getStats() });
});

/**
 * GET /api/history/corrections
 * Where a manual correction disagreed with what was suggested — the closest
 * thing to an accuracy report this app has.
 */
router.get('/history/corrections', (req, res) => {
  const limit = parseIntParam(req.query.limit, 100, { min: 1, max: 500 });
  res.json({ corrections: historyService.getCorrections(limit) });
});

/** DELETE /api/history — clear the log. */
router.delete('/history', (_req, res) => {
  const removed = historyService.clear();
  res.json({ ok: true, removed });
});

/** POST /api/history/prune — apply the retention policy now. */
router.post('/history/prune', (_req, res) => {
  const removed = historyService.prune();
  res.json({ ok: true, removed });
});

// ─── Settings ──────────────────────────────────────────────────────────────────

/**
 * GET /api/settings
 * Effective values plus the schema, so the UI can render the form from here
 * rather than duplicating the field list.
 */
router.get('/settings', (_req, res) => {
  res.json({
    settings: settingsStore.getAll(),
    schema: settingsStore.describe(),
    overridden: settingsStore.getOverriddenKeys(),
    appVersion: version,
    // Read-only: these are process-level and cannot be changed at runtime.
    readOnly: {
      port: config.port,
      logLevel: config.logLevel,
      authEnabled: !!config.apiToken,
      database: {
        host: config.database.host,
        port: config.database.port,
        name: config.database.name,
        user: config.database.user,
        ssl: config.database.ssl,
      },
    },
  });
});

/**
 * PATCH /api/settings
 * Validate and persist a partial settings update. All-or-nothing.
 */
router.patch('/settings', (req, res) => {
  const { changed, requiresSchedulerReload } = settingsStore.setMany(req.body || {});
  if (requiresSchedulerReload) scheduler.reload();
  res.json({
    ok: true,
    changed,
    settings: settingsStore.getAll(),
    schema: settingsStore.describe(),
  });
});

/** DELETE /api/settings/:key — revert one setting to its environment default. */
router.delete('/settings/:key', (req, res) => {
  const reverted = settingsStore.reset(req.params.key);
  if (reverted && settingsStore.SCHEMA[req.params.key].restart) scheduler.reload();
  res.json({ ok: true, reverted, settings: settingsStore.getAll(), schema: settingsStore.describe() });
});

/** DELETE /api/settings — revert everything. */
router.delete('/settings', (_req, res) => {
  const reverted = settingsStore.resetAll();
  if (reverted.some((key) => settingsStore.SCHEMA[key].restart)) scheduler.reload();
  res.json({ ok: true, reverted, settings: settingsStore.getAll(), schema: settingsStore.describe() });
});

/** GET /api/models — which models Ollama actually has pulled. */
router.get(
  '/models',
  wrap(async (_req, res) => {
    const status = await ollamaService.healthCheck();
    res.json({
      ok: status.ok,
      models: status.models,
      current: settingsStore.get('ollama.model'),
      modelAvailable: status.modelAvailable,
      error: status.error,
      // Sensible picks for a CPU-only box like the Intel N100 this runs on.
      recommended: [
        { name: 'qwen2.5:3b-instruct-q4_K_M', note: 'Best accuracy/speed balance on CPU' },
        { name: 'llama3.2:3b-instruct-q4_K_M', note: 'Slightly faster, a little less accurate' },
        { name: 'mistral:7b-instruct-q4_K_M', note: 'More accurate, noticeably slower on CPU' },
      ],
    });
  })
);

// ─── Word Lists ────────────────────────────────────────────────────────────────

router.get('/wordlists', (_req, res) => {
  res.json({
    wordLists: germanWordLists.getWordLists(),
    summary: germanWordLists.getWordListSummary(),
  });
});

/**
 * POST /api/wordlists/test
 * Show what the word lists would do with a title, without calling the LLM.
 */
router.post(
  '/wordlists/test',
  wrap(async (req, res) => {
    const { title, notes } = req.body || {};
    if (!title || typeof title !== 'string') fail(400, 'title must be a non-empty string');

    const categories = await categorizationService.getCategories();
    res.json(germanWordLists.explain({ title, notes }, categories));
  })
);

/** POST /api/wordlists/:listName/keywords */
router.post('/wordlists/:listName/keywords', (req, res) => {
  const { listName } = req.params;
  const { keyword } = req.body || {};
  if (typeof keyword !== 'string') fail(400, 'keyword must be a string');

  const result = germanWordLists.addKeyword(listName, keyword);
  res.json({ ok: true, listName, ...result });
});

/** DELETE /api/wordlists/:listName/keywords/:keyword */
router.delete('/wordlists/:listName/keywords/:keyword', (req, res) => {
  const { listName, keyword } = req.params;
  const result = germanWordLists.removeKeyword(listName, keyword);
  res.json({ ok: true, listName, ...result });
});

/** POST /api/wordlists/:listName/reset — restore the shipped keywords. */
router.post('/wordlists/:listName/reset', (req, res) => {
  const listName = req.params.listName === 'all' ? undefined : req.params.listName;
  const reset = germanWordLists.resetList(listName);
  res.json({ ok: true, reset, wordLists: germanWordLists.getWordLists() });
});

// ─── Prompt Template ───────────────────────────────────────────────────────────

router.get('/prompt/template', (_req, res) => {
  const custom = settingsStore.get('ollama.customPromptTemplate');
  res.json({
    isCustom: !!custom,
    template: custom || ollamaService.getDefaultPromptTemplate(),
    defaultTemplate: ollamaService.getDefaultPromptTemplate(),
    placeholders: ollamaService.TEMPLATE_PLACEHOLDERS,
  });
});

/**
 * POST /api/prompt/template
 * Persisted, unlike before — a custom prompt used to live only in memory and
 * was lost on every restart. Validated so a template missing its placeholders
 * cannot silently break every categorization.
 */
router.post('/prompt/template', (req, res) => {
  const { template } = req.body || {};
  if (typeof template !== 'string') fail(400, 'template must be a string');

  ollamaService.validatePromptTemplate(template);
  settingsStore.setMany({ 'ollama.customPromptTemplate': template });
  res.json({ ok: true, isCustom: true, template });
});

/** POST /api/prompt/preview — render a template against a sample expense. */
router.post(
  '/prompt/preview',
  wrap(async (req, res) => {
    const { template, title, amount, notes, currency } = req.body || {};
    const categories = await categorizationService.getCategories();
    const expense = {
      title: title || 'Rewe Wocheneinkauf',
      amount: parseIntParam(amount, 4250, { min: 0 }),
      notes: notes || '',
      currency: currency || 'EUR',
    };

    if (template) {
      ollamaService.validatePromptTemplate(template);
      return res.json({
        prompt: ollamaService.buildCustomPrompt(expense, categories, template),
        expense,
      });
    }
    res.json({ prompt: ollamaService.buildPrompt(expense, categories), expense });
  })
);

/** DELETE /api/prompt/template — back to the built-in prompt. */
router.delete('/prompt/template', (_req, res) => {
  settingsStore.setMany({ 'ollama.customPromptTemplate': null });
  res.json({ ok: true, isCustom: false, template: ollamaService.getDefaultPromptTemplate() });
});

// ─── Unknown API routes ────────────────────────────────────────────────────────
// Without this the SPA catch-all in app.js answers /api typos with a 200 and an
// HTML page, so a client mistake looks like success.
router.use((req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} /api${req.path}` });
});

module.exports = router;
