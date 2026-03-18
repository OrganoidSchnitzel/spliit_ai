'use strict';

/**
 * Processing history service.
 * Maintains a local SQLite database (data/history.db) that records every
 * categorization attempt – whether it was auto-applied or left for manual
 * review.  Inspired by paperless-ai's document processing log.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'history.db');

// Ensure the data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Create the history table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    expense_id  TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    group_name  TEXT,
    amount      INTEGER NOT NULL,
    currency    TEXT,
    category_id INTEGER,
    category_name TEXT,
    confidence  REAL,
    reasoning   TEXT,
    status      TEXT    NOT NULL,
    provider    TEXT,
    processed_at TEXT   NOT NULL DEFAULT (datetime('now'))
  )
`);

/**
 * Record the result of a categorization attempt.
 * @param {object} params
 * @param {string}  params.expenseId
 * @param {string}  params.title
 * @param {string}  [params.groupName]
 * @param {number}  params.amount       - Amount in cents
 * @param {string}  [params.currency]
 * @param {number}  [params.categoryId]
 * @param {string}  [params.categoryName]
 * @param {number}  [params.confidence]
 * @param {string}  [params.reasoning]
 * @param {string}  params.status       - 'applied' | 'low_confidence' | 'error'
 * @param {string}  [params.provider]   - 'ollama' | 'openai'
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
}) {
  const stmt = db.prepare(`
    INSERT INTO history
      (expense_id, title, group_name, amount, currency, category_id, category_name,
       confidence, reasoning, status, provider)
    VALUES
      (@expenseId, @title, @groupName, @amount, @currency, @categoryId, @categoryName,
       @confidence, @reasoning, @status, @provider)
  `);
  stmt.run({
    expenseId,
    title,
    groupName: groupName || null,
    amount,
    currency: currency || null,
    categoryId: categoryId || null,
    categoryName: categoryName || null,
    confidence: confidence !== undefined ? confidence : null,
    reasoning: reasoning || null,
    status,
    provider: provider || null,
  });
}

/**
 * Return the most recent history records.
 * @param {number} [limit=50]
 * @returns {Array<object>}
 */
function getHistory(limit = 50) {
  return db
    .prepare(
      `SELECT * FROM history ORDER BY processed_at DESC LIMIT ?`
    )
    .all(limit);
}

/**
 * Return aggregate stats from the history table.
 * @returns {{ total: number, applied: number, lowConfidence: number, errors: number }}
 */
function getStats() {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'applied'        THEN 1 ELSE 0 END) AS applied,
         SUM(CASE WHEN status = 'low_confidence' THEN 1 ELSE 0 END) AS lowConfidence,
         SUM(CASE WHEN status = 'error'          THEN 1 ELSE 0 END) AS errors
       FROM history`
    )
    .get();
  return row;
}

module.exports = { recordResult, getHistory, getStats };
