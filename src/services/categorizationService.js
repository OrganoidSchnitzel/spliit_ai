'use strict';

const db = require('../db');
const AIServiceFactory = require('./aiServiceFactory');
const historyService = require('./historyService');
const config = require('../config');

/**
 * Fetch all available categories from the Spliit database.
 * @returns {Promise<Array<{ id: number, grouping: string, name: string }>>}
 */
async function getCategories() {
  const res = await db.query(
    'SELECT id, grouping, name FROM "Category" ORDER BY grouping, name'
  );
  return res.rows;
}

/**
 * Fetch expenses that have not yet been categorized (categoryId = 0).
 * @param {number} [limit]
 * @returns {Promise<Array>}
 */
async function getUncategorizedExpenses(limit) {
  const cap = limit || config.processing.batchSize;
  const res = await db.query(
    `SELECT e.id, e.title, e.amount, e.notes, e."expenseDate",
            g.currency, g.name AS "groupName"
     FROM "Expense" e
     JOIN "Group" g ON g.id = e."groupId"
     WHERE e."categoryId" = 0 AND e."isReimbursement" = false
     ORDER BY e."expenseDate" DESC
     LIMIT $1`,
    [cap]
  );
  return res.rows;
}

/**
 * Fetch a single expense by its ID including group info.
 * @param {string} expenseId
 * @returns {Promise<object|null>}
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
 * Process a single expense: ask the AI service for a suggestion and, if confidence
 * exceeds the threshold, apply it automatically.
 *
 * @param {object} expense
 * @param {Array} categories
 * @returns {{ expenseId: string, status: 'applied'|'low_confidence'|'error', suggestion?: object, error?: string }}
 */
async function processExpense(expense, categories) {
  const aiService = AIServiceFactory.getService();
  try {
    const suggestion = await aiService.suggestCategory(expense, categories);
    const categoryEntry = categories.find((c) => c.id === suggestion.categoryId);
    const categoryName = categoryEntry ? categoryEntry.name : null;

    if (suggestion.confidence >= config.confidenceThreshold) {
      await updateExpenseCategory(expense.id, suggestion.categoryId);
      console.log(
        `[Categorization] Applied category ${suggestion.categoryId} to "${expense.title}" (confidence=${suggestion.confidence.toFixed(2)})`
      );
      historyService.recordResult({
        expenseId: expense.id,
        title: expense.title,
        groupName: expense.groupName,
        amount: expense.amount,
        currency: expense.currency,
        categoryId: suggestion.categoryId,
        categoryName,
        confidence: suggestion.confidence,
        reasoning: suggestion.reasoning,
        status: 'applied',
        provider: config.aiProvider,
      });
      return { expenseId: expense.id, status: 'applied', suggestion };
    }

    console.log(
      `[Categorization] Low confidence for "${expense.title}": ${suggestion.confidence.toFixed(2)} < ${config.confidenceThreshold}`
    );
    historyService.recordResult({
      expenseId: expense.id,
      title: expense.title,
      groupName: expense.groupName,
      amount: expense.amount,
      currency: expense.currency,
      categoryId: suggestion.categoryId,
      categoryName,
      confidence: suggestion.confidence,
      reasoning: suggestion.reasoning,
      status: 'low_confidence',
      provider: config.aiProvider,
    });
    return { expenseId: expense.id, status: 'low_confidence', suggestion };
  } catch (err) {
    console.error(`[Categorization] Error processing "${expense.title}": ${err.message}`);
    historyService.recordResult({
      expenseId: expense.id,
      title: expense.title,
      groupName: expense.groupName,
      amount: expense.amount,
      currency: expense.currency,
      status: 'error',
      reasoning: err.message,
      provider: config.aiProvider,
    });
    return { expenseId: expense.id, status: 'error', error: err.message };
  }
}

/**
 * Run automatic categorization for all uncategorized expenses up to batchSize.
 * @returns {Promise<{ processed: number, applied: number, lowConfidence: number, errors: number }>}
 */
async function runBatch() {
  console.log('[Categorization] Starting batch run...');

  const [categories, expenses] = await Promise.all([
    getCategories(),
    getUncategorizedExpenses(),
  ]);

  if (categories.length === 0) {
    console.warn('[Categorization] No categories found in database. Aborting.');
    return { processed: 0, applied: 0, lowConfidence: 0, errors: 0 };
  }

  console.log(
    `[Categorization] Found ${expenses.length} uncategorized expense(s). Categories: ${categories.length}`
  );

  const stats = { processed: 0, applied: 0, lowConfidence: 0, errors: 0 };

  for (const expense of expenses) {
    const result = await processExpense(expense, categories);
    stats.processed++;
    if (result.status === 'applied') stats.applied++;
    else if (result.status === 'low_confidence') stats.lowConfidence++;
    else stats.errors++;
  }

  console.log(
    `[Categorization] Batch done. processed=${stats.processed} applied=${stats.applied} low_confidence=${stats.lowConfidence} errors=${stats.errors}`
  );
  return stats;
}

module.exports = {
  getCategories,
  getUncategorizedExpenses,
  getExpenseById,
  updateExpenseCategory,
  processExpense,
  runBatch,
};
