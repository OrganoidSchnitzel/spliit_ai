'use strict';

const categorizationService = require('../src/services/categorizationService');

// ─── Mock dependencies ────────────────────────────────────────────────────────
jest.mock('../src/db', () => ({
  query: jest.fn(),
  healthCheck: jest.fn(),
  pool: {},
}));

// Mock the AI service factory so it returns a stable mock
const mockAiService = { suggestCategory: jest.fn() };
jest.mock('../src/services/aiServiceFactory', () => ({
  getService: () => mockAiService,
}));

// Suppress SQLite history writes in unit tests
jest.mock('../src/services/historyService', () => ({
  recordResult: jest.fn(),
  getHistory: jest.fn(() => []),
  getStats: jest.fn(() => ({ total: 0, applied: 0, lowConfidence: 0, errors: 0 })),
}));

const db = require('../src/db');

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

describe('categorizationService.processExpense', () => {
  beforeEach(() => {
    db.query.mockReset();
    mockAiService.suggestCategory.mockReset();
  });

  it('applies category when confidence meets threshold', async () => {
    mockAiService.suggestCategory.mockResolvedValue({
      categoryId: 1,
      confidence: 0.9,
      reasoning: 'Grocery store',
    });
    db.query.mockResolvedValue({ rows: [] }); // UPDATE

    const result = await categorizationService.processExpense(EXPENSE, CATEGORIES);

    expect(result.status).toBe('applied');
    expect(result.suggestion.categoryId).toBe(1);
    expect(db.query).toHaveBeenCalledWith(
      'UPDATE "Expense" SET "categoryId" = $1 WHERE id = $2',
      [1, 'e-1']
    );
  });

  it('returns low_confidence when confidence is below threshold', async () => {
    mockAiService.suggestCategory.mockResolvedValue({
      categoryId: 2,
      confidence: 0.3,
      reasoning: 'Maybe transport?',
    });

    const result = await categorizationService.processExpense(EXPENSE, CATEGORIES);

    expect(result.status).toBe('low_confidence');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns error status when AI service throws', async () => {
    mockAiService.suggestCategory.mockRejectedValue(new Error('AI timeout'));

    const result = await categorizationService.processExpense(EXPENSE, CATEGORIES);

    expect(result.status).toBe('error');
    expect(result.error).toContain('AI timeout');
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('categorizationService.runBatch', () => {
  beforeEach(() => {
    db.query.mockReset();
    mockAiService.suggestCategory.mockReset();
  });

  it('returns zero stats when there are no uncategorized expenses', async () => {
    db.query
      .mockResolvedValueOnce({ rows: CATEGORIES })  // getCategories
      .mockResolvedValueOnce({ rows: [] });           // getUncategorizedExpenses

    const stats = await categorizationService.runBatch();
    expect(stats.processed).toBe(0);
    expect(stats.applied).toBe(0);
  });

  it('processes all expenses and tracks stats correctly', async () => {
    db.query
      .mockResolvedValueOnce({ rows: CATEGORIES })        // getCategories
      .mockResolvedValueOnce({ rows: [EXPENSE, { id: 'e-2', title: 'Gas station', amount: 5000, currency: 'EUR', notes: null, expenseDate: '2024-01-16', groupName: 'Home' }] }) // getUncategorizedExpenses
      .mockResolvedValue({ rows: [] });                   // UPDATE calls

    mockAiService.suggestCategory
      .mockResolvedValueOnce({ categoryId: 1, confidence: 0.85, reasoning: 'Groceries' })
      .mockResolvedValueOnce({ categoryId: 2, confidence: 0.4, reasoning: 'Maybe fuel' });

    const stats = await categorizationService.runBatch();
    expect(stats.processed).toBe(2);
    expect(stats.applied).toBe(1);
    expect(stats.lowConfidence).toBe(1);
    expect(stats.errors).toBe(0);
  });

  it('aborts gracefully when no categories are found', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // getCategories → empty
      .mockResolvedValueOnce({ rows: [] }); // getUncategorizedExpenses

    const stats = await categorizationService.runBatch();
    expect(stats.processed).toBe(0);
    expect(mockAiService.suggestCategory).not.toHaveBeenCalled();
  });
});
