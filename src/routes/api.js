'use strict';

const express = require('express');
const { version } = require('../../package.json');
const db = require('../db');
const ollamaService = require('../services/ollamaService');
const categorizationService = require('../services/categorizationService');
const historyService = require('../services/historyService');
const germanWordLists = require('../data/germanWordLists');
const config = require('../config');

const router = express.Router();

// ─── Health ────────────────────────────────────────────────────────────────────

router.get('/health', async (_req, res) => {
  try {
    const [dbOk, ollamaStatus] = await Promise.all([
      db.healthCheck(),
      ollamaService.healthCheck(),
    ]);
    res.json({
      status: dbOk && ollamaStatus.ok ? 'ok' : 'degraded',
      database: { ok: dbOk },
      ollama: ollamaStatus,
      scheduler: {
        enabled: config.scheduler.enabled,
        cron: config.scheduler.cronExpression,
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ─── Categories ────────────────────────────────────────────────────────────────

router.get('/categories', async (_req, res) => {
  try {
    const categories = await categorizationService.getCategories();
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Expenses ──────────────────────────────────────────────────────────────────

/**
 * GET /api/expenses/uncategorized
 * Returns uncategorized expenses (up to batchSize).
 */
router.get('/expenses/uncategorized', async (_req, res) => {
  try {
    const expenses = await categorizationService.getUncategorizedExpenses();
    res.json({ expenses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/expenses/:id/suggest
 * Ask the AI service to suggest a category for a specific expense WITHOUT applying it.
 * Used by the playground.
 */
router.post('/expenses/:id/suggest', async (req, res) => {
  const { id } = req.params;
  try {
    const [expense, categories] = await Promise.all([
      categorizationService.getExpenseById(id),
      categorizationService.getCategories(),
    ]);

    if (!expense) {
      return res.status(404).json({ error: `Expense ${id} not found` });
    }
    if (categories.length === 0) {
      return res.status(400).json({ error: 'No categories found in database' });
    }

    const suggestion = await ollamaService.suggestCategory(expense, categories);
    const category = categories.find((c) => c.id === suggestion.categoryId);

    res.json({
      expense: { id: expense.id, title: expense.title, amount: expense.amount },
      suggestion: { ...suggestion, categoryName: category ? category.name : null },
      meetsThreshold: suggestion.confidence >= config.confidenceThreshold,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/expenses/:id/apply
 * Apply a specific categoryId to an expense.
 */
router.post('/expenses/:id/apply', async (req, res) => {
  const { id } = req.params;
  const { categoryId } = req.body;

  if (!categoryId || !Number.isInteger(Number(categoryId))) {
    return res.status(400).json({ error: 'categoryId must be an integer' });
  }

  try {
    const [expense, categories] = await Promise.all([
      categorizationService.getExpenseById(id),
      categorizationService.getCategories(),
    ]);

    if (!expense) {
      return res.status(404).json({ error: `Expense ${id} not found` });
    }

    const valid = categories.find((c) => c.id === Number(categoryId));
    if (!valid) {
      return res.status(400).json({ error: `Category ${categoryId} does not exist` });
    }

    await categorizationService.updateExpenseCategory(id, Number(categoryId));
    res.json({ ok: true, expenseId: id, categoryId: Number(categoryId), categoryName: valid.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Batch processing ──────────────────────────────────────────────────────────

/**
 * POST /api/process
 * Manually trigger a batch categorization run.
 */
router.post('/process', async (_req, res) => {
  try {
    const stats = await categorizationService.runBatch();
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── History ───────────────────────────────────────────────────────────────────

/**
 * GET /api/history?limit=50
 * Returns the most recent processing history records.
 */
router.get('/history', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const rows = historyService.getHistory(limit);
    const stats = historyService.getStats();
    res.json({ history: rows, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Settings (read-only view of current config) ───────────────────────────────

/**
 * GET /api/settings
 * Returns the current non-sensitive configuration for display in the UI.
 */
router.get('/settings', (_req, res) => {
  res.json({
    ollama: {
      baseUrl: config.ollama.baseUrl,
      model: config.ollama.model,
      customPromptTemplate: config.ollama.customPromptTemplate,
    },
    confidenceThreshold: config.confidenceThreshold,
    scheduler: config.scheduler,
    processing: config.processing,
    appVersion: version,
  });
});

// ─── Word Lists ────────────────────────────────────────────────────────────────

/**
 * GET /api/wordlists
 * Returns all German word lists for category matching.
 */
router.get('/wordlists', (_req, res) => {
  try {
    const wordLists = germanWordLists.getWordLists();
    res.json({ wordLists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/wordlists/:listName/keywords
 * Add a keyword to a specific word list.
 */
router.post('/wordlists/:listName/keywords', (req, res) => {
  const { listName } = req.params;
  const { keyword } = req.body;

  if (!keyword || typeof keyword !== 'string') {
    return res.status(400).json({ error: 'keyword must be a string' });
  }

  try {
    const success = germanWordLists.addKeyword(listName, keyword);
    if (!success) {
      return res.status(400).json({ error: 'Failed to add keyword (list not found or keyword already exists)' });
    }
    res.json({ ok: true, listName, keyword: keyword.toLowerCase().trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/wordlists/:listName/keywords/:keyword
 * Remove a keyword from a specific word list.
 */
router.delete('/wordlists/:listName/keywords/:keyword', (req, res) => {
  const { listName, keyword } = req.params;

  try {
    const success = germanWordLists.removeKeyword(listName, keyword);
    if (!success) {
      return res.status(404).json({ error: 'Keyword not found in list' });
    }
    res.json({ ok: true, listName, keyword: keyword.toLowerCase().trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Prompt Template ───────────────────────────────────────────────────────────

/**
 * GET /api/prompt/template
 * Returns the current prompt template (default or custom).
 */
router.get('/prompt/template', (_req, res) => {
  try {
    res.json({
      isCustom: !!config.ollama.customPromptTemplate,
      template: config.ollama.customPromptTemplate || getDefaultPromptTemplate(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/prompt/template
 * Update the custom prompt template (only updates in-memory, not persisted).
 */
router.post('/prompt/template', (req, res) => {
  const { template } = req.body;

  if (!template || typeof template !== 'string') {
    return res.status(400).json({ error: 'template must be a string' });
  }

  try {
    config.ollama.customPromptTemplate = template;
    res.json({ ok: true, template });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/prompt/template
 * Reset to default prompt template.
 */
router.delete('/prompt/template', (_req, res) => {
  try {
    config.ollama.customPromptTemplate = null;
    res.json({ ok: true, template: getDefaultPromptTemplate() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Helper to get the default prompt template as a string.
 */
function getDefaultPromptTemplate() {
  return `Categorize expense. Return JSON only.
Title:{{title}}
Amount:{{amount}}
Notes:{{notes}}
Categories(id:name): {{categories}}

Rules:
- Pick ONE category ID from list
- German context: Lidl/Rewe/Edeka/Aldi/Kaufland→grocery, Tankstelle→fuel, IKEA/Möbel→furniture
- Match by merchant type, not just word similarity
- Output format:
{"reasoning":"<why>","categoryName":"<exact name>","categoryId":<id>,"confidence":<0-1>}`;
}

module.exports = router;
