'use strict';

/**
 * Processing history.
 *
 * Records every categorization attempt — auto-applied, left for review, or
 * failed — and doubles as the scheduler's memory: `getAttemptState()` is what
 * stops a stuck expense from being re-sent to the LLM every 15 minutes forever.
 */

const localDb = require('../localDb');
const settingsStore = require('../settingsStore');

/** Statuses a history row can carry. */
const STATUS = {
  APPLIED: 'applied',
  LOW_CONFIDENCE: 'low_confidence',
  ERROR: 'error',
  MANUAL: 'manual',
  DRY_RUN: 'dry_run',
};

/** Statuses that mean "this expense still needs another attempt". */
const RETRYABLE_STATUSES = [STATUS.LOW_CONFIDENCE, STATUS.ERROR];

let stmts = null;

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function init() {
  const db = localDb.get();

  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id    TEXT    NOT NULL,
      title         TEXT    NOT NULL,
      group_name    TEXT,
      amount        INTEGER NOT NULL,
      currency      TEXT,
      category_id   INTEGER,
      category_name TEXT,
      confidence    REAL,
      reasoning     TEXT,
      status        TEXT    NOT NULL,
      provider      TEXT,
      processed_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Additive migrations for databases created by earlier versions.
  const existing = columnNames(db, 'history');
  const additions = [
    ['source', "ALTER TABLE history ADD COLUMN source TEXT"],
    ['duration_ms', 'ALTER TABLE history ADD COLUMN duration_ms INTEGER'],
    ['parked', 'ALTER TABLE history ADD COLUMN parked INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [column, sql] of additions) {
    if (!existing.includes(column)) db.exec(sql);
  }

  // Without these, every history read is a full scan plus sort, and the table
  // is append-only.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_history_processed_at ON history(processed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_history_expense_id   ON history(expense_id);
    CREATE INDEX IF NOT EXISTS idx_history_status       ON history(status);
  `);

  // Expenses the user explicitly told us to stop retrying.
  db.exec(`
    CREATE TABLE IF NOT EXISTS parked_expenses (
      expense_id TEXT PRIMARY KEY,
      reason     TEXT,
      parked_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  stmts = {
    insert: db.prepare(`
      INSERT INTO history
        (expense_id, title, group_name, amount, currency, category_id, category_name,
         confidence, reasoning, status, provider, source, duration_ms)
      VALUES
        (@expenseId, @title, @groupName, @amount, @currency, @categoryId, @categoryName,
         @confidence, @reasoning, @status, @provider, @source, @durationMs)
    `),
    park: db.prepare(`
      INSERT INTO parked_expenses (expense_id, reason)
      VALUES (@expenseId, @reason)
      ON CONFLICT(expense_id) DO UPDATE SET reason = @reason, parked_at = datetime('now')
    `),
    unpark: db.prepare('DELETE FROM parked_expenses WHERE expense_id = ?'),
    parkedIds: db.prepare('SELECT expense_id FROM parked_expenses'),
    attemptState: db.prepare(`
      SELECT expense_id                                        AS expenseId,
             COUNT(*)                                          AS attempts,
             MAX(processed_at)                                 AS lastAttemptAt,
             (julianday('now') - julianday(MAX(processed_at))) * 24 AS hoursSinceLast
      FROM history
      WHERE status IN (${RETRYABLE_STATUSES.map(() => '?').join(',')})
      GROUP BY expense_id
    `),
    prune: db.prepare(
      "DELETE FROM history WHERE processed_at < datetime('now', ?)"
    ),
  };

  return db;
}

/**
 * Record the result of a categorization attempt.
 * @param {object} params
 */
function recordResult({
  expenseId,
  title,
  groupName,
  amount,
  currency,
  categoryId,
  categoryName,
  confidence,
  reasoning,
  status,
  provider,
  source,
  durationMs,
}) {
  stmts.insert.run({
    expenseId,
    title,
    groupName: groupName || null,
    amount: amount ?? 0,
    currency: currency || null,
    categoryId: categoryId ?? null,
    categoryName: categoryName || null,
    confidence: confidence !== undefined ? confidence : null,
    reasoning: reasoning || null,
    status,
    provider: provider || 'ollama',
    source: source || null,
    durationMs: durationMs ?? null,
  });
}

/**
 * Per-expense retry state, used by the scheduler to skip expenses that were
 * attempted too recently.
 * @returns {Map<string, { attempts: number, lastAttemptAt: string, hoursSinceLast: number }>}
 */
function getAttemptState() {
  const map = new Map();
  for (const row of stmts.attemptState.all(...RETRYABLE_STATUSES)) {
    map.set(row.expenseId, {
      attempts: row.attempts,
      lastAttemptAt: row.lastAttemptAt,
      hoursSinceLast: row.hoursSinceLast,
    });
  }
  return map;
}

/** Expense IDs the user parked. */
function getParkedExpenseIds() {
  return stmts.parkedIds.all().map((r) => r.expense_id);
}

function parkExpense(expenseId, reason) {
  stmts.park.run({ expenseId, reason: reason || null });
}

function unparkExpense(expenseId) {
  return stmts.unpark.run(expenseId).changes > 0;
}

/**
 * Recent history records with optional filtering.
 * @param {{ limit?: number, status?: string, search?: string, offset?: number }} [opts]
 */
function getHistory(opts = {}) {
  const { limit = 50, status, search, offset = 0 } = opts;
  const db = localDb.get();

  const where = [];
  const params = [];
  if (status && status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }
  if (search) {
    where.push('(LOWER(title) LIKE ? OR LOWER(COALESCE(group_name, \'\')) LIKE ?)');
    const like = `%${String(search).toLowerCase()}%`;
    params.push(like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT * FROM history ${whereSql} ORDER BY processed_at DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM history ${whereSql}`)
    .get(...params);

  const parked = new Set(getParkedExpenseIds());
  return {
    rows: rows.map((r) => ({ ...r, is_parked: parked.has(r.expense_id) ? 1 : 0 })),
    total,
  };
}

/**
 * Aggregate stats. Includes average latency, which is the number that tells
 * you whether the word lists and keep_alive are actually helping.
 */
function getStats() {
  const db = localDb.get();
  const row = db
    .prepare(
      `SELECT
         COUNT(*)                                                      AS total,
         SUM(CASE WHEN status = 'applied'        THEN 1 ELSE 0 END)    AS applied,
         SUM(CASE WHEN status = 'low_confidence' THEN 1 ELSE 0 END)    AS lowConfidence,
         SUM(CASE WHEN status = 'error'          THEN 1 ELSE 0 END)    AS errors,
         SUM(CASE WHEN status = 'manual'         THEN 1 ELSE 0 END)    AS manual,
         SUM(CASE WHEN status = 'dry_run'        THEN 1 ELSE 0 END)    AS dryRun,
         SUM(CASE WHEN source = 'wordlist'       THEN 1 ELSE 0 END)    AS viaWordList,
         SUM(CASE WHEN source = 'llm'            THEN 1 ELSE 0 END)    AS viaLlm,
         AVG(CASE WHEN source = 'llm' THEN duration_ms END)            AS avgLlmMs
       FROM history`
    )
    .get();

  const parked = db.prepare('SELECT COUNT(*) AS n FROM parked_expenses').get().n;
  return { ...row, parked, avgLlmMs: row.avgLlmMs ? Math.round(row.avgLlmMs) : null };
}

/**
 * How often the model's suggestion was later corrected by hand — the closest
 * thing to an accuracy signal this app has.
 */
function getCorrections(limit = 100) {
  const db = localDb.get();
  return db
    .prepare(
      `SELECT m.expense_id, m.title, m.category_name AS corrected_to, m.processed_at,
              (SELECT category_name FROM history p
                WHERE p.expense_id = m.expense_id
                  AND p.status <> 'manual'
                  AND p.processed_at <= m.processed_at
                ORDER BY p.processed_at DESC LIMIT 1) AS suggested,
              (SELECT source FROM history p
                WHERE p.expense_id = m.expense_id
                  AND p.status <> 'manual'
                  AND p.processed_at <= m.processed_at
                ORDER BY p.processed_at DESC LIMIT 1) AS suggested_source
       FROM history m
       WHERE m.status = 'manual'
       ORDER BY m.processed_at DESC
       LIMIT ?`
    )
    .all(limit)
    .filter((r) => r.suggested && r.suggested !== r.corrected_to);
}

/**
 * Delete history older than the retention window.
 * @returns {number} rows removed
 */
function prune() {
  const days = settingsStore.get('history.retentionDays');
  const { changes } = stmts.prune.run(`-${days} days`);
  if (changes > 0) {
    console.log(`[History] Pruned ${changes} record(s) older than ${days} days.`);
  }
  return changes;
}

function clear() {
  const db = localDb.get();
  const { changes } = db.prepare('DELETE FROM history').run();
  return changes;
}

module.exports = {
  init,
  recordResult,
  getHistory,
  getStats,
  getCorrections,
  getAttemptState,
  getParkedExpenseIds,
  parkExpense,
  unparkExpense,
  prune,
  clear,
  STATUS,
};
