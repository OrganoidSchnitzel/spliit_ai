'use strict';

const db = require('../db');
const ollamaService = require('./ollamaService');
const historyService = require('./historyService');
const settingsStore = require('../settingsStore');

/** Spliit's category table is a fixed seed list; re-reading it per request is waste. */
const CATEGORY_CACHE_TTL_MS = 5 * 60 * 1000;
let categoryCache = { rows: null, fetchedAt: 0 };

/** Only one batch may run at a time; the cron tick and the UI button share this. */
let activeRun = null;
let lastRunSummary = null;

/**
 * Fetch all available categories from the Spliit database.
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<Array<{ id: number, grouping: string, name: string }>>}
 */
async function getCategories(opts = {}) {
  const fresh = Date.now() - categoryCache.fetchedAt < CATEGORY_CACHE_TTL_MS;
  if (!opts.force && categoryCache.rows && fresh) return categoryCache.rows;

  const res = await db.query(
    'SELECT id, grouping, name FROM "Category" ORDER BY grouping, name'
  );
  categoryCache = { rows: res.rows, fetchedAt: Date.now() };
  return res.rows;
}

function invalidateCategoryCache() {
  categoryCache = { rows: null, fetchedAt: 0 };
}

/**
 * Fetch expenses that have not yet been categorized.
 * @param {{ limit?: number, excludeIds?: string[] }} [opts]
 */
async function getUncategorizedExpenses(opts = {}) {
  const limit = opts.limit || settingsStore.get('processing.batchSize');
  const excludeIds = opts.excludeIds || [];

  const res = await db.query(
    `SELECT e.id, e.title, e.amount, e.notes, e."expenseDate",
            g.currency, g.name AS "groupName"
     FROM "Expense" e
     JOIN "Group" g ON g.id = e."groupId"
     WHERE e."categoryId" = 0
       AND e."isReimbursement" = false
       AND ($2::text[] IS NULL OR e.id <> ALL($2::text[]))
     ORDER BY e."expenseDate" DESC
     LIMIT $1`,
    [limit, excludeIds.length ? excludeIds : null]
  );
  return res.rows;
}

/** Count of everything still uncategorized, regardless of batch size. */
async function countUncategorized() {
  const res = await db.query(
    `SELECT COUNT(*)::int AS n
     FROM "Expense" e
     WHERE e."categoryId" = 0 AND e."isReimbursement" = false`
  );
  return res.rows[0].n;
}

/**
 * Fetch a single expense by ID including group info.
 * @param {string} expenseId
 */
async function getExpenseById(expenseId) {
  const res = await db.query(
    `SELECT e.id, e.title, e.amount, e.notes, e."expenseDate", e."categoryId",
            g.currency, g.name AS "groupName"
     FROM "Expense" e
     JOIN "Group" g ON g.id = e."groupId"
     WHERE e.id = $1`,
    [expenseId]
  );
  return res.rows[0] || null;
}

/**
 * Update the categoryId of an expense in the Spliit database.
 * @param {string} expenseId
 * @param {number} categoryId
 */
async function updateExpenseCategory(expenseId, categoryId) {
  await db.query('UPDATE "Expense" SET "categoryId" = $1 WHERE id = $2', [
    categoryId,
    expenseId,
  ]);
}

/**
 * Decide whether an expense is due for another attempt.
 *
 * Without this, an expense that never clears the confidence threshold stays at
 * categoryId = 0 and is re-sent to the LLM on every run, forever. With
 * ORDER BY expenseDate DESC and a batch size of 10, eleven stuck expenses were
 * enough to permanently starve every older uncategorized expense.
 *
 * @param {{ attempts: number, hoursSinceLast: number } | undefined} state
 * @param {number[]} backoff - escalating wait in hours
 * @returns {{ due: boolean, parked: boolean, waitHours?: number }}
 */
function isDue(state, backoff) {
  if (!state) return { due: true, parked: false };
  if (state.attempts > backoff.length) {
    return { due: false, parked: true };
  }
  const waitHours = backoff[state.attempts - 1];
  if (state.hoursSinceLast >= waitHours) return { due: true, parked: false };
  return { due: false, parked: false, waitHours };
}

/**
 * Process a single expense: ask for a suggestion and apply it if it clears the
 * confidence threshold.
 *
 * @param {object} expense
 * @param {Array} categories
 * @param {{ dryRun?: boolean }} [opts]
 */
async function processExpense(expense, categories, opts = {}) {
  const threshold = settingsStore.get('confidenceThreshold');
  const dryRun = opts.dryRun ?? settingsStore.get('dryRun');
  const autoApplyWordList = settingsStore.get('autoApplyWordListMatches');

  const base = {
    expenseId: expense.id,
    title: expense.title,
    groupName: expense.groupName,
    amount: expense.amount,
    currency: expense.currency,
  };

  try {
    const suggestion = await ollamaService.suggestCategory(expense, categories);
    const categoryEntry = categories.find((c) => c.id === suggestion.categoryId);
    const categoryName = categoryEntry ? categoryEntry.name : suggestion.categoryName;

    const record = {
      ...base,
      categoryId: suggestion.categoryId,
      categoryName,
      confidence: suggestion.confidence,
      reasoning: suggestion.reasoning,
      source: suggestion.source,
      durationMs: suggestion.durationMs,
    };

    const meetsThreshold = suggestion.confidence >= threshold;
    const wordListBlocked = suggestion.source === 'wordlist' && !autoApplyWordList;

    if (!meetsThreshold || wordListBlocked) {
      const why = wordListBlocked
        ? 'word-list auto-apply is off'
        : `${suggestion.confidence.toFixed(2)} < ${threshold}`;
      console.log(`[Categorization] Holding "${expense.title}" for review: ${why}`);
      historyService.recordResult({ ...record, status: historyService.STATUS.LOW_CONFIDENCE });
      return { expenseId: expense.id, status: 'low_confidence', suggestion };
    }

    if (dryRun) {
      console.log(
        `[Categorization] DRY RUN — would set category ${suggestion.categoryId} on "${expense.title}"`
      );
      historyService.recordResult({ ...record, status: historyService.STATUS.DRY_RUN });
      return { expenseId: expense.id, status: 'dry_run', suggestion };
    }

    await updateExpenseCategory(expense.id, suggestion.categoryId);
    console.log(
      `[Categorization] Applied ${suggestion.categoryId} to "${expense.title}" ` +
        `(confidence=${suggestion.confidence.toFixed(2)}, via ${suggestion.source})`
    );
    historyService.recordResult({ ...record, status: historyService.STATUS.APPLIED });
    return { expenseId: expense.id, status: 'applied', suggestion };
  } catch (err) {
    console.error(`[Categorization] Error processing "${expense.title}": ${err.message}`);
    historyService.recordResult({
      ...base,
      status: historyService.STATUS.ERROR,
      reasoning: err.message,
    });
    return { expenseId: expense.id, status: 'error', error: err.message };
  }
}

/**
 * Record a category the user chose by hand.
 *
 * A manual correction is the strongest accuracy signal this app gets — the
 * user stating the right answer for a title the model got wrong — so it is
 * written to the history log rather than only to Spliit.
 *
 * @param {object} expense
 * @param {{ id: number, name: string }} category
 * @param {{ note?: string }} [opts]
 */
async function applyManualCategory(expense, category, opts = {}) {
  await updateExpenseCategory(expense.id, category.id);
  historyService.recordResult({
    expenseId: expense.id,
    title: expense.title,
    groupName: expense.groupName,
    amount: expense.amount,
    currency: expense.currency,
    categoryId: category.id,
    categoryName: category.name,
    confidence: 1,
    reasoning: opts.note || 'Set manually from the UI.',
    status: historyService.STATUS.MANUAL,
    source: 'manual',
  });
  // A corrected expense should not stay parked.
  historyService.unparkExpense(expense.id);
  return { expenseId: expense.id, categoryId: category.id, categoryName: category.name };
}

/**
 * Run automatic categorization over the due uncategorized expenses.
 *
 * @param {{ force?: boolean, dryRun?: boolean }} [opts] - `force` ignores backoff
 */
async function runBatch(opts = {}) {
  if (activeRun) {
    console.log('[Categorization] A batch is already running; skipping this trigger.');
    // Do not spread lastRunSummary here: it carries its own numeric `skipped`
    // count, which would clobber this flag.
    return { skipped: true, reason: 'already_running', lastRun: lastRunSummary };
  }

  activeRun = (async () => {
    const startedAt = Date.now();
    console.log('[Categorization] Starting batch run...');

    const batchSize = settingsStore.get('processing.batchSize');
    const backoff = settingsStore.get('processing.retryBackoffHours');

    const parkedIds = historyService.getParkedExpenseIds();
    const [categories, candidates] = await Promise.all([
      getCategories(),
      // Over-fetch so that skipping recently-attempted expenses still fills
      // the batch instead of leaving the run half empty.
      getUncategorizedExpenses({ limit: batchSize * 4, excludeIds: parkedIds }),
    ]);

    if (categories.length === 0) {
      console.warn('[Categorization] No categories found in database. Aborting.');
      return { processed: 0, applied: 0, lowConfidence: 0, errors: 0, skipped: 0, parked: 0 };
    }

    const attemptState = historyService.getAttemptState();
    const due = [];
    let deferred = 0;
    let newlyParked = 0;

    for (const expense of candidates) {
      if (due.length >= batchSize) break;
      if (opts.force) {
        due.push(expense);
        continue;
      }
      const verdict = isDue(attemptState.get(expense.id), backoff);
      if (verdict.due) due.push(expense);
      else if (verdict.parked) {
        historyService.parkExpense(
          expense.id,
          `No confident category after ${backoff.length + 1} attempts.`
        );
        newlyParked += 1;
      } else deferred += 1;
    }

    console.log(
      `[Categorization] ${candidates.length} uncategorized candidate(s); ` +
        `${due.length} due, ${deferred} waiting on backoff, ${newlyParked} newly parked.`
    );

    const stats = {
      processed: 0,
      applied: 0,
      lowConfidence: 0,
      errors: 0,
      dryRun: 0,
      skipped: deferred,
      parked: newlyParked,
    };

    for (const expense of due) {
      const result = await processExpense(expense, categories, opts);
      stats.processed += 1;
      if (result.status === 'applied') stats.applied += 1;
      else if (result.status === 'low_confidence') stats.lowConfidence += 1;
      else if (result.status === 'dry_run') stats.dryRun += 1;
      else stats.errors += 1;
    }

    stats.durationMs = Date.now() - startedAt;
    console.log(
      `[Categorization] Batch done in ${stats.durationMs}ms. ` +
        `processed=${stats.processed} applied=${stats.applied} ` +
        `low_confidence=${stats.lowConfidence} errors=${stats.errors}`
    );

    try {
      historyService.prune();
    } catch (err) {
      console.warn(`[Categorization] History prune failed: ${err.message}`);
    }

    lastRunSummary = { ...stats, finishedAt: new Date().toISOString() };
    return stats;
  })();

  try {
    return await activeRun;
  } finally {
    activeRun = null;
  }
}

function isRunning() {
  return activeRun !== null;
}

function getLastRunSummary() {
  return lastRunSummary;
}

module.exports = {
  getCategories,
  invalidateCategoryCache,
  getUncategorizedExpenses,
  countUncategorized,
  getExpenseById,
  updateExpenseCategory,
  applyManualCategory,
  processExpense,
  runBatch,
  isDue,
  isRunning,
  getLastRunSummary,
};
