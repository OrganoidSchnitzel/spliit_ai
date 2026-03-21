'use strict';

/**
 * Integration-style tests for the Express API using supertest.
 * The database and Ollama are mocked so these run without external services.
 */

const request = require('supertest');
const app = require('../src/app');

// ─── Mock external dependencies ──────────────────────────────────────────────
jest.mock('../src/db', () => ({
  query: jest.fn(),
  healthCheck: jest.fn().mockResolvedValue(true),
  pool: {},
}));

jest.mock('../src/services/ollamaService', () => ({
  healthCheck: jest.fn().mockResolvedValue({ ok: true, models: ['llama3.2'] }),
  suggestCategory: jest.fn(),
  buildPrompt: jest.requireActual('../src/services/ollamaService').buildPrompt,
  stripMarkdown: jest.requireActual('../src/services/ollamaService').stripMarkdown,
}));

// Suppress SQLite history writes in API tests
jest.mock('../src/services/historyService', () => ({
  recordResult: jest.fn(),
  getHistory: jest.fn(() => []),
  getStats: jest.fn(() => ({ total: 0, applied: 0, lowConfidence: 0, errors: 0 })),
}));

const db = require('../src/db');
const ollamaService = require('../src/services/ollamaService');

const MOCK_CATEGORIES = [
  { id: 1, grouping: 'Food & Drink', name: 'Groceries' },
  { id: 2, grouping: 'Transport', name: 'Fuel' },
];

const MOCK_EXPENSE = {
  id: 'exp-abc',
  title: 'Supermarket run',
  amount: 3500,
  notes: null,
  expenseDate: '2024-02-01',
  currency: 'EUR',
  groupName: 'Berlin flatmates',
  categoryId: 0,
};

describe('GET /api/health', () => {
  it('returns status ok when all services are healthy', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database.ok).toBe(true);
    expect(res.body.ollama.ok).toBe(true);
  });
});

describe('GET /api/settings', () => {
  it('returns non-sensitive config without any API keys', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ollama');
    expect(res.body).toHaveProperty('confidenceThreshold');
    expect(res.body).toHaveProperty('scheduler');
    expect(res.body).toHaveProperty('appVersion');
    expect(res.body).not.toHaveProperty('openai');
  });
});

describe('GET /api/history', () => {
  it('returns history array and stats', async () => {
    const res = await request(app).get('/api/history');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('history');
    expect(res.body).toHaveProperty('stats');
    expect(Array.isArray(res.body.history)).toBe(true);
  });
});

describe('GET /api/categories', () => {
  beforeEach(() => {
    db.query.mockResolvedValue({ rows: MOCK_CATEGORIES });
  });

  it('returns the list of categories', async () => {
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(2);
    expect(res.body.categories[0].name).toBe('Groceries');
  });
});

describe('GET /api/expenses/uncategorized', () => {
  beforeEach(() => {
    db.query.mockResolvedValue({ rows: [MOCK_EXPENSE] });
  });

  it('returns uncategorized expenses', async () => {
    const res = await request(app).get('/api/expenses/uncategorized');
    expect(res.status).toBe(200);
    expect(res.body.expenses).toHaveLength(1);
    expect(res.body.expenses[0].title).toBe('Supermarket run');
  });
});

describe('POST /api/expenses/:id/suggest', () => {
  beforeEach(() => {
    // First call returns the expense, second call returns categories
    db.query
      .mockResolvedValueOnce({ rows: [MOCK_EXPENSE] })   // getExpenseById
      .mockResolvedValueOnce({ rows: MOCK_CATEGORIES }); // getCategories

    ollamaService.suggestCategory.mockResolvedValue({
      categoryId: 1,
      confidence: 0.88,
      reasoning: 'Expense title mentions supermarket.',
    });
  });

  it('returns a suggestion without applying it', async () => {
    const res = await request(app)
      .post('/api/expenses/exp-abc/suggest')
      .send();

    expect(res.status).toBe(200);
    expect(res.body.suggestion.categoryId).toBe(1);
    expect(res.body.suggestion.confidence).toBeCloseTo(0.88);
    expect(res.body.meetsThreshold).toBe(true);
    // Must NOT have written to DB (no UPDATE call)
    const updateCalls = db.query.mock.calls.filter((c) => c[0].includes('UPDATE'));
    expect(updateCalls).toHaveLength(0);
  });

  it('returns 404 for unknown expense id', async () => {
    db.query.mockReset();
    db.query
      .mockResolvedValueOnce({ rows: [] })               // getExpenseById → not found
      .mockResolvedValueOnce({ rows: MOCK_CATEGORIES }); // getCategories

    const res = await request(app).post('/api/expenses/unknown-id/suggest').send();
    expect(res.status).toBe(404);
  });
});

describe('POST /api/expenses/:id/apply', () => {
  beforeEach(() => {
    db.query
      .mockResolvedValueOnce({ rows: [MOCK_EXPENSE] })   // getExpenseById
      .mockResolvedValueOnce({ rows: MOCK_CATEGORIES })  // getCategories
      .mockResolvedValue({ rows: [] });                   // UPDATE
  });

  it('applies a valid category', async () => {
    const res = await request(app)
      .post('/api/expenses/exp-abc/apply')
      .send({ categoryId: 1 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.categoryName).toBe('Groceries');

    const updateCalls = db.query.mock.calls.filter((c) => c[0].includes('UPDATE'));
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][1]).toEqual([1, 'exp-abc']);
  });

  it('rejects an invalid categoryId', async () => {
    const res = await request(app)
      .post('/api/expenses/exp-abc/apply')
      .send({ categoryId: 'not-a-number' });

    expect(res.status).toBe(400);
  });

  it('rejects a categoryId that does not exist', async () => {
    const res = await request(app)
      .post('/api/expenses/exp-abc/apply')
      .send({ categoryId: 999 });

    expect(res.status).toBe(400);
  });
});
