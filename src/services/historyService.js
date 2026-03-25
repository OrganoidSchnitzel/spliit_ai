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
    provider    TEXT,   -- retained for schema compatibility; always 'ollama'
    processed_at TEXT   NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const DEFAULT_CATEGORY_PROMPT_TEMPLATE = `You are an expense categorization assistant for Spliit.
You must always return valid JSON only.

Rules:
1) Choose exactly one category from the provided list.
2) categoryName must exactly match one list entry name. categoryId must be the exact ID of that same entry.
3) Expense titles and notes are often in German (for example: Lidl, Rewe, Edeka, Aldi, Kaufland, Tankstelle). Interpret German context correctly before mapping to a category.
4) If uncertain, pick the best matching category and lower confidence.
5) JSON key order is mandatory: output "reasoning" first, then "categoryName", then "categoryId", then "confidence".
6) Never invent or alter category names. categoryName MUST be one of: {{ALLOWED_NAMES}}.
7) Reasoning must describe the spending type first (e.g., groceries, fuel, furniture), then map that type to the closest category from the list.
8) Do not map by superficial word overlap. First infer what was purchased or the merchant type, then choose the closest category from the list.
9) For household/furniture item titles (e.g., Schrank, Tisch, Stuhl), avoid food-related categories unless the merchant clearly indicates food service or groceries{{FOOD_LIKE_NAMES}}.

{{EXAMPLE_SECTION}}

Expense:
  Title: {{TITLE}}
  Amount: {{AMOUNT}}{{NOTES_PART}}

Available categories:
{{CATEGORY_LIST}}

Respond ONLY with valid JSON in this exact format:
{
  "reasoning": "<short explanation>",
  "categoryName": "<exact category name from the list above>",
  "categoryId": <integer id from the list above that exactly matches categoryName>,
  "confidence": <float between 0 and 1>
}
No markdown, no extra keys.`;

const DEFAULT_DETERMINISTIC_CATEGORY_RULES = [
  { keyword: 'lidl', categoryPattern: 'grocer|grocery|supermarket|lebensmittel', reasoning: 'Lidl is a supermarket.' },
  { keyword: 'rewe', categoryPattern: 'grocer|grocery|supermarket|lebensmittel', reasoning: 'Rewe is a supermarket.' },
  { keyword: 'edeka', categoryPattern: 'grocer|grocery|supermarket|lebensmittel', reasoning: 'Edeka is a supermarket.' },
  { keyword: 'aldi', categoryPattern: 'grocer|grocery|supermarket|lebensmittel', reasoning: 'Aldi is a supermarket.' },
  { keyword: 'kaufland', categoryPattern: 'grocer|grocery|supermarket|lebensmittel', reasoning: 'Kaufland is a supermarket.' },
  { keyword: 'penny', categoryPattern: 'grocer|grocery|supermarket|lebensmittel', reasoning: 'Penny is a supermarket.' },
  { keyword: 'netto', categoryPattern: 'grocer|grocery|supermarket|lebensmittel', reasoning: 'Netto is a supermarket.' },
  { keyword: 'dm', categoryPattern: 'drogerie|drug|personal care|health|household', reasoning: 'dm is a drugstore.' },
  { keyword: 'rossmann', categoryPattern: 'drogerie|drug|personal care|health|household', reasoning: 'Rossmann is a drugstore.' },
  { keyword: 'ikea', categoryPattern: 'möbel|moebel|furniture|home|household|living|interior|wohnung|wohnen', reasoning: 'IKEA is furniture/home retail.' },
];

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

function getSettingValue(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSettingValue(key, value) {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);
  stmt.run(key, value);
}

function getCategorizationPromptTemplate() {
  const value = getSettingValue('categorizationPromptTemplate');
  return value || DEFAULT_CATEGORY_PROMPT_TEMPLATE;
}

function setCategorizationPromptTemplate(value) {
  setSettingValue('categorizationPromptTemplate', value);
}

function getDeterministicCategoryRules() {
  const value = getSettingValue('deterministicCategoryRules');
  if (!value) return DEFAULT_DETERMINISTIC_CATEGORY_RULES;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : DEFAULT_DETERMINISTIC_CATEGORY_RULES;
  } catch {
    return DEFAULT_DETERMINISTIC_CATEGORY_RULES;
  }
}

function setDeterministicCategoryRules(rules) {
  setSettingValue('deterministicCategoryRules', JSON.stringify(rules));
}

module.exports = {
  recordResult,
  getHistory,
  getStats,
  getCategorizationPromptTemplate,
  setCategorizationPromptTemplate,
  getDeterministicCategoryRules,
  setDeterministicCategoryRules,
  DEFAULT_CATEGORY_PROMPT_TEMPLATE,
  DEFAULT_DETERMINISTIC_CATEGORY_RULES,
};
