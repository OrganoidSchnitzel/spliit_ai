'use strict';

const express = require('express');
const { version } = require('../../package.json');
const db = require('../db');
const ollamaService = require('../services/ollamaService');
const categorizationService = require('../services/categorizationService');
const historyService = require('../services/historyService');
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
    },
    confidenceThreshold: config.confidenceThreshold,
    scheduler: config.scheduler,
    processing: config.processing,
    appVersion: version,
  });
});

module.exports = router;
