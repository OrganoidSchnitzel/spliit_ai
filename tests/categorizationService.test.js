'use strict';

jest.mock('../src/db', () => ({
  query: jest.fn(),
  healthCheck: jest.fn(),
  pool: {},
}));

jest.mock('../src/services/ollamaService', () => ({
  suggestCategory: jest.fn(),
}));

const localDb = require('../src/localDb');
const settingsStore = require('../src/settingsStore');
const historyService = require('../src/services/historyService');
const categorizationService = require('../src/services/categorizationService');
const db = require('../src/db');
const ollamaService = require('../src/services/ollamaService');

const CATEGORIES = [
  { id: 1, grouping: 'Food', name: 'Groceries' },
  { id: 2, grouping: 'Transport', name: 'Fuel' },
];

const EXPENSE = {
  id: 'e-1',
  title: 'Aldi',
  amount: 2000,
  currency: 'EUR',
  notes: null,
  expenseDate: '2024-01-15',
  groupName: 'Home',
};

beforeAll(() => {
  localDb.init();
  settingsStore.init();
  historyService.init();
});

beforeEach(() => {
  historyService.clear();
  settingsStore.resetAll();
  categorizationService.invalidateCategoryCache();
});

describe('processExpense', () => {
  it('applies a suggestion that clears the threshold', async () => {
    ollamaService.suggestCategory.mockResolvedValue({
      categoryId: 1, categoryName: 'Groceries', confidence: 0.9, reasoning: 'r', source: 'llm',
    });
    db.query.mockResolvedValue({ rows: [] });

    const res = await categorizationService.processExpense(EXPENSE, CATEGORIES);

    expect(res.status).toBe('applied');
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE "Expense"'), [1, 'e-1']);
  });

  it('holds a suggestion below the threshold without writing to Spliit', async () => {
    ollamaService.suggestCategory.mockResolvedValue({
      categoryId: 1, categoryName: 'Groceries', confidence: 0.2, reasoning: 'r', source: 'llm',
    });

    const res = await categorizationService.processExpense(EXPENSE, CATEGORIES);

    expect(res.status).toBe('low_confidence');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('records an error rather than throwing', async () => {
    ollamaService.suggestCategory.mockRejectedValue(new Error('Ollama exploded'));

    const res = await categorizationService.processExpense(EXPENSE, CATEGORIES);

    expect(res).toMatchObject({ status: 'error', error: 'Ollama exploded' });
    const { rows } = historyService.getHistory({ limit: 1 });
    expect(rows[0]).toMatchObject({ status: 'error', reasoning: 'Ollama exploded' });
  });

  it('writes nothing to Spliit in dry-run mode but still logs', async () => {
    settingsStore.setMany({ dryRun: true });
    ollamaService.suggestCategory.mockResolvedValue({
      categoryId: 1, categoryName: 'Groceries', confidence: 0.95, reasoning: 'r', source: 'wordlist',
    });

    const res = await categorizationService.processExpense(EXPENSE, CATEGORIES);

    expect(res.status).toBe('dry_run');
    expect(db.query).not.toHaveBeenCalled();
    expect(historyService.getHistory({ limit: 1 }).rows[0].status).toBe('dry_run');
  });

  it('holds word-list matches for review when auto-apply is off', async () => {
    settingsStore.setMany({ autoApplyWordListMatches: false });
    ollamaService.suggestCategory.mockResolvedValue({
      categoryId: 1, categoryName: 'Groceries', confidence: 0.95, reasoning: 'r', source: 'wordlist',
    });

    expect((await categorizationService.processExpense(EXPENSE, CATEGORIES)).status).toBe('low_confidence');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('records the source and duration for later analysis', async () => {
    ollamaService.suggestCategory.mockResolvedValue({
      categoryId: 1, categoryName: 'Groceries', confidence: 0.9, reasoning: 'r',
      source: 'wordlist', durationMs: 12,
    });
    db.query.mockResolvedValue({ rows: [] });

    await categorizationService.processExpense(EXPENSE, CATEGORIES);

    expect(historyService.getHistory({ limit: 1 }).rows[0]).toMatchObject({
      source: 'wordlist',
      duration_ms: 12,
    });
  });
});

describe('isDue — retry backoff', () => {
  const backoff = [1, 6, 24];

  it('processes an expense that has never been attempted', () => {
    expect(categorizationService.isDue(undefined, backoff)).toEqual({ due: true, parked: false });
  });

  it('defers an expense attempted more recently than the backoff allows', () => {
    expect(categorizationService.isDue({ attempts: 1, hoursSinceLast: 0.5 }, backoff)).toMatchObject({
      due: false, parked: false, waitHours: 1,
    });
  });

  it('retries once the backoff has elapsed', () => {
    expect(categorizationService.isDue({ attempts: 1, hoursSinceLast: 2 }, backoff).due).toBe(true);
  });

  it('escalates the wait with each attempt', () => {
    expect(categorizationService.isDue({ attempts: 2, hoursSinceLast: 3 }, backoff).waitHours).toBe(6);
    expect(categorizationService.isDue({ attempts: 3, hoursSinceLast: 10 }, backoff).waitHours).toBe(24);
  });

  it('parks an expense once the backoff steps are exhausted', () => {
    expect(categorizationService.isDue({ attempts: 4, hoursSinceLast: 999 }, backoff)).toMatchObject({
      due: false, parked: true,
    });
  });
});

describe('runBatch', () => {
  const mockQueries = ({ categories = CATEGORIES, expenses = [] } = {}) => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('FROM "Category"')) return Promise.resolve({ rows: categories });
      if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ n: expenses.length }] });
      if (sql.includes('FROM "Expense"')) return Promise.resolve({ rows: expenses });
      return Promise.resolve({ rows: [] });
    });
  };

  it('aborts when the database has no categories', async () => {
    mockQueries({ categories: [] });
    expect(await categorizationService.runBatch()).toMatchObject({ processed: 0 });
  });

  it('skips an expense that was attempted too recently', async () => {
    mockQueries({ expenses: [EXPENSE] });
    // A failed attempt right now puts the expense inside the first backoff step.
    historyService.recordResult({
      expenseId: 'e-1', title: 'Aldi', amount: 2000, status: 'low_confidence',
    });

    const stats = await categorizationService.runBatch();

    expect(stats.processed).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(ollamaService.suggestCategory).not.toHaveBeenCalled();
  });

  it('processes a recently-attempted expense when forced', async () => {
    mockQueries({ expenses: [EXPENSE] });
    historyService.recordResult({
      expenseId: 'e-1', title: 'Aldi', amount: 2000, status: 'low_confidence',
    });
    ollamaService.suggestCategory.mockResolvedValue({
      categoryId: 1, categoryName: 'Groceries', confidence: 0.9, reasoning: 'r', source: 'llm',
    });

    expect((await categorizationService.runBatch({ force: true })).processed).toBe(1);
  });

  it('parks an expense once its attempts are exhausted', async () => {
    mockQueries({ expenses: [EXPENSE] });
    for (let i = 0; i < 4; i += 1) {
      historyService.recordResult({
        expenseId: 'e-1', title: 'Aldi', amount: 2000, status: 'low_confidence',
      });
    }

    const stats = await categorizationService.runBatch();

    expect(stats.parked).toBe(1);
    expect(historyService.getParkedExpenseIds()).toContain('e-1');
  });

  it('refuses to start a second run while one is in flight', async () => {
    mockQueries({ expenses: [EXPENSE] });
    let release;
    ollamaService.suggestCategory.mockReturnValue(new Promise((r) => { release = r; }));

    const first = categorizationService.runBatch();
    const second = await categorizationService.runBatch();

    expect(second).toMatchObject({ skipped: true, reason: 'already_running' });

    release({ categoryId: 1, categoryName: 'Groceries', confidence: 0.1, reasoning: 'r', source: 'llm' });
    await first;
    expect(categorizationService.isRunning()).toBe(false);
  });
});

describe('applyManualCategory', () => {
  it('writes to Spliit and records the correction in history', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await categorizationService.applyManualCategory(EXPENSE, { id: 2, name: 'Fuel' }, {
      note: 'Corrected from "Groceries".',
    });

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE "Expense"'), [2, 'e-1']);
    expect(historyService.getHistory({ limit: 1 }).rows[0]).toMatchObject({
      status: 'manual',
      category_name: 'Fuel',
      source: 'manual',
      confidence: 1,
    });
  });

  it('un-parks a corrected expense', async () => {
    db.query.mockResolvedValue({ rows: [] });
    historyService.parkExpense('e-1', 'test');

    await categorizationService.applyManualCategory(EXPENSE, { id: 2, name: 'Fuel' });

    expect(historyService.getParkedExpenseIds()).not.toContain('e-1');
  });
});

describe('getCategories caching', () => {
  it('reuses the cached category list instead of re-querying', async () => {
    db.query.mockResolvedValue({ rows: CATEGORIES });

    await categorizationService.getCategories();
    await categorizationService.getCategories();
    await categorizationService.getCategories();

    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('re-queries when forced', async () => {
    db.query.mockResolvedValue({ rows: CATEGORIES });
    await categorizationService.getCategories();
    await categorizationService.getCategories({ force: true });
    expect(db.query).toHaveBeenCalledTimes(2);
  });
});
