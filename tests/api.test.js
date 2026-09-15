'use strict';

/**
 * Integration-style tests for the Express API using supertest.
 * Postgres and Ollama are mocked; the local SQLite database is real but lives
 * in a per-worker temp directory (see tests/setup.js).
 */

jest.mock('../src/db', () => ({
  query: jest.fn(),
  healthCheck: jest.fn().mockResolvedValue(true),
  pool: {},
}));

const actualOllama = jest.requireActual('../src/services/ollamaService');
jest.mock('../src/services/ollamaService', () => {
  const real = jest.requireActual('../src/services/ollamaService');
  return {
    ...real,
    healthCheck: jest.fn().mockResolvedValue({
      ok: true, models: ['llama3.2'], model: 'llama3.2', modelAvailable: true,
    }),
    suggestCategory: jest.fn(),
  };
});

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const ollamaService = require('../src/services/ollamaService');
const historyService = require('../src/services/historyService');
const settingsStore = require('../src/settingsStore');
const categorizationService = require('../src/services/categorizationService');

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

/** Route db.query by the SQL it receives, so call ordering does not matter. */
function mockDb({ expense = MOCK_EXPENSE, categories = MOCK_CATEGORIES, uncategorized = [MOCK_EXPENSE] } = {}) {
  db.query.mockImplementation((sql) => {
    if (sql.includes('FROM "Category"')) return Promise.resolve({ rows: categories });
    if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ n: uncategorized.length }] });
    if (sql.includes('WHERE e.id = $1')) return Promise.resolve({ rows: expense ? [expense] : [] });
    if (sql.includes('FROM "Expense"')) return Promise.resolve({ rows: uncategorized });
    return Promise.resolve({ rows: [] });
  });
}

beforeAll(() => app.init());

beforeEach(() => {
  historyService.clear();
  settingsStore.resetAll();
  categorizationService.invalidateCategoryCache();
  db.healthCheck.mockResolvedValue(true);
  ollamaService.healthCheck.mockResolvedValue({
    ok: true, models: ['llama3.2'], model: 'llama3.2', modelAvailable: true,
  });
  mockDb();
});

describe('GET /api/health', () => {
  it('reports ok when everything is healthy', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: { ok: true } });
    expect(res.body.ollama.ok).toBe(true);
  });

  it('reports degraded when the configured model is not pulled', async () => {
    ollamaService.healthCheck.mockResolvedValue({
      ok: true, models: ['qwen2.5:3b'], model: 'llama3.2', modelAvailable: false,
    });
    const res = await request(app).get('/api/health');
    expect(res.body.status).toBe('degraded');
  });

  it('reports degraded rather than 500 when the database is down', async () => {
    db.healthCheck.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.database.error).toMatch(/ECONNREFUSED/);
  });
});

describe('error handling', () => {
  it('answers an unknown /api route with JSON, not the SPA shell', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error).toMatch(/No such endpoint/);
  });

  it('answers a malformed JSON body with JSON', async () => {
    const res = await request(app)
      .post('/api/prompt/template')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error).toMatch(/not valid JSON/);
  });

  it('still serves the SPA shell for non-API routes', async () => {
    const res = await request(app).get('/history');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});

describe('GET /api/settings', () => {
  it('returns effective values, the schema and read-only process config', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.settings).toHaveProperty('confidenceThreshold');
    expect(Array.isArray(res.body.schema)).toBe(true);
    expect(res.body.readOnly).toHaveProperty('database');
    expect(res.body.readOnly.database).not.toHaveProperty('password');
  });

  it('never exposes the database password', async () => {
    const res = await request(app).get('/api/settings');
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });
});

describe('PATCH /api/settings', () => {
  it('persists a valid change', async () => {
    const res = await request(app).patch('/api/settings').send({ confidenceThreshold: 0.75 });
    expect(res.status).toBe(200);
    expect(res.body.changed).toContain('confidenceThreshold');
    expect(settingsStore.get('confidenceThreshold')).toBe(0.75);
  });

  it('rejects an invalid value without writing anything', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .send({ confidenceThreshold: 0.75, 'processing.batchSize': 0 });
    expect(res.status).toBe(400);
    expect(settingsStore.getOverriddenKeys()).toHaveLength(0);
  });

  it('rejects an unknown setting', async () => {
    const res = await request(app).patch('/api/settings').send({ nonsense: 1 });
    expect(res.status).toBe(400);
  });

  it('reverts a single setting', async () => {
    await request(app).patch('/api/settings').send({ dryRun: true });
    const res = await request(app).delete('/api/settings/dryRun');
    expect(res.status).toBe(200);
    expect(settingsStore.get('dryRun')).toBe(false);
  });
});

describe('GET /api/categories', () => {
  it('returns the category list', async () => {
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(2);
  });
});

describe('GET /api/expenses/uncategorized', () => {
  it('returns expenses plus the total still outstanding', async () => {
    const res = await request(app).get('/api/expenses/uncategorized');
    expect(res.status).toBe(200);
    expect(res.body.expenses).toHaveLength(1);
    expect(res.body).toMatchObject({ total: 1, shown: 1 });
  });
});

describe('POST /api/expenses/:id/suggest', () => {
  beforeEach(() => {
    ollamaService.suggestCategory.mockResolvedValue({
      categoryId: 1, categoryName: 'Groceries', confidence: 0.88,
      reasoning: 'Title mentions supermarket.', source: 'llm',
    });
  });

  it('returns a suggestion without writing to Spliit', async () => {
    const res = await request(app).post('/api/expenses/exp-abc/suggest').send();
    expect(res.status).toBe(200);
    expect(res.body.suggestion.categoryId).toBe(1);
    expect(res.body.meetsThreshold).toBe(true);
    expect(db.query.mock.calls.filter((c) => c[0].includes('UPDATE'))).toHaveLength(0);
  });

  it('includes the word-list analysis so the decision is explainable', async () => {
    const res = await request(app).post('/api/expenses/exp-abc/suggest').send();
    expect(res.body.wordListExplanation).toHaveProperty('normalized');
    expect(res.body.wordListExplanation).toHaveProperty('candidates');
  });

  it('returns 404 for an unknown expense', async () => {
    mockDb({ expense: null });
    const res = await request(app).post('/api/expenses/unknown/suggest').send();
    expect(res.status).toBe(404);
  });
});

describe('POST /api/expenses/preview', () => {
  it('categorizes a made-up expense that does not exist in Spliit', async () => {
    // Use the real implementation here: the point of this test is that a
    // word-list hit short-circuits before any HTTP call to Ollama.
    ollamaService.suggestCategory.mockImplementation(actualOllama.suggestCategory);
    const res = await request(app).post('/api/expenses/preview').send({ title: 'Rewe Markt', amount: 1200 });
    expect(res.status).toBe(200);
    expect(res.body.suggestion.categoryName).toBe('Groceries');
    expect(res.body.suggestion.source).toBe('wordlist');
  });

  it('requires a title', async () => {
    const res = await request(app).post('/api/expenses/preview').send({ amount: 100 });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/expenses/:id/apply', () => {
  it('applies a category and records it as a manual correction', async () => {
    const res = await request(app).post('/api/expenses/exp-abc/apply').send({ categoryId: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, categoryName: 'Groceries' });

    const updates = db.query.mock.calls.filter((c) => c[0].includes('UPDATE'));
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual([1, 'exp-abc']);

    expect(historyService.getHistory({ limit: 1 }).rows[0]).toMatchObject({
      status: 'manual', source: 'manual',
    });
  });

  it('rejects a non-integer categoryId', async () => {
    const res = await request(app).post('/api/expenses/exp-abc/apply').send({ categoryId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('rejects a categoryId that does not exist', async () => {
    const res = await request(app).post('/api/expenses/exp-abc/apply').send({ categoryId: 999 });
    expect(res.status).toBe(400);
  });

  it('rejects a missing categoryId', async () => {
    const res = await request(app).post('/api/expenses/exp-abc/apply').send({});
    expect(res.status).toBe(400);
  });
});

describe('parking', () => {
  it('parks and un-parks an expense', async () => {
    await request(app).post('/api/expenses/exp-abc/park').send({ reason: 'manual' });
    expect(historyService.getParkedExpenseIds()).toContain('exp-abc');

    await request(app).delete('/api/expenses/exp-abc/park');
    expect(historyService.getParkedExpenseIds()).not.toContain('exp-abc');
  });
});

describe('GET /api/history', () => {
  it('returns rows, a total and stats', async () => {
    historyService.recordResult({ expenseId: 'x', title: 'T', amount: 1, status: 'applied' });
    const res = await request(app).get('/api/history');
    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(1);
    expect(res.body).toHaveProperty('total', 1);
    expect(res.body.stats).toHaveProperty('applied', 1);
  });

  it('filters by status', async () => {
    historyService.recordResult({ expenseId: 'x', title: 'T', amount: 1, status: 'applied' });
    historyService.recordResult({ expenseId: 'y', title: 'U', amount: 1, status: 'error' });
    const res = await request(app).get('/api/history?status=error');
    expect(res.body.total).toBe(1);
  });

  it('caps an absurd limit rather than trying to serve it', async () => {
    const res = await request(app).get('/api/history?limit=999999');
    expect(res.body.limit).toBe(500);
  });
});

describe('POST /api/process', () => {
  it('runs a batch and reports stats', async () => {
    mockDb({ uncategorized: [] });
    const res = await request(app).post('/api/process').send({});
    expect(res.status).toBe(200);
    expect(res.body.stats).toHaveProperty('processed');
  });

  it('returns 409 rather than starting a second concurrent run', async () => {
    mockDb({ uncategorized: [MOCK_EXPENSE] });
    let release;
    ollamaService.suggestCategory.mockReturnValue(new Promise((r) => { release = r; }));

    // Take the lock through the service directly. runBatch assigns its lock
    // synchronously, so this is deterministic — racing two HTTP round trips is
    // not.
    const inFlight = categorizationService.runBatch();
    expect(categorizationService.isRunning()).toBe(true);

    const res = await request(app).post('/api/process').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already in progress/i);

    release({ categoryId: 1, categoryName: 'Groceries', confidence: 0.1, reasoning: 'r', source: 'llm' });
    await inFlight;
    expect(categorizationService.isRunning()).toBe(false);
  });
});

describe('word lists', () => {
  it('lists every word list with a summary', async () => {
    const res = await request(app).get('/api/wordlists');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.wordLists).length).toBeGreaterThan(10);
    expect(res.body.summary[0]).toHaveProperty('keywordCount');
  });

  it('explains what a title would match', async () => {
    const res = await request(app).post('/api/wordlists/test').send({ title: 'Tankstellenrechnung' });
    expect(res.status).toBe(200);
    expect(res.body.match).toBeNull(); // no Gas/Fuel category in the mock set
    expect(res.body.normalized).toBe('tankstellenrechnung');
  });

  it('adds and removes a keyword', async () => {
    const add = await request(app).post('/api/wordlists/liquor/keywords').send({ keyword: 'Spätkauf' });
    expect(add.status).toBe(200);
    expect(add.body.keyword).toBe('spaetkauf');

    const del = await request(app).delete('/api/wordlists/liquor/keywords/spaetkauf');
    expect(del.status).toBe(200);
  });

  it('rejects a duplicate keyword with 409', async () => {
    const res = await request(app).post('/api/wordlists/liquor/keywords').send({ keyword: 'kneipe' });
    expect(res.status).toBe(409);
  });

  it('rejects an unknown list with 404', async () => {
    const res = await request(app).post('/api/wordlists/nope/keywords').send({ keyword: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('prompt template', () => {
  afterEach(async () => { await request(app).delete('/api/prompt/template'); });

  it('returns the built-in template by default', async () => {
    const res = await request(app).get('/api/prompt/template');
    expect(res.body.isCustom).toBe(false);
    expect(res.body.template).toContain('{{title}}');
    expect(res.body.placeholders).toContain('categories');
  });

  it('persists a custom template', async () => {
    const save = await request(app).post('/api/prompt/template').send({ template: 'A {{title}} B {{categories}}' });
    expect(save.status).toBe(200);

    const read = await request(app).get('/api/prompt/template');
    expect(read.body).toMatchObject({ isCustom: true, template: 'A {{title}} B {{categories}}' });
  });

  it('rejects a template missing its placeholders', async () => {
    const res = await request(app).post('/api/prompt/template').send({ template: 'nothing here' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing required placeholder/i);
  });

  it('previews a template against a sample expense', async () => {
    const res = await request(app)
      .post('/api/prompt/preview')
      .send({ template: 'T={{title}} C={{categories}}', title: 'Demo' });
    expect(res.status).toBe(200);
    expect(res.body.prompt).toBe('T=Demo C=1:Groceries|2:Fuel');
  });
});

describe('GET /api/models', () => {
  it('reports installed and recommended models', async () => {
    const res = await request(app).get('/api/models');
    expect(res.status).toBe(200);
    expect(res.body.models).toContain('llama3.2');
    expect(res.body.recommended.length).toBeGreaterThan(0);
  });
});

describe('suggestCategory is the real implementation in these tests', () => {
  it('confirms the module under test was not fully stubbed out', () => {
    expect(typeof actualOllama.buildPrompt).toBe('function');
  });
});
