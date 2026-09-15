'use strict';

const localDb = require('../src/localDb');
const settingsStore = require('../src/settingsStore');
const historyService = require('../src/services/historyService');

const row = (over = {}) => ({
  expenseId: 'e-1', title: 'Aldi', amount: 2000, currency: 'EUR', status: 'applied', ...over,
});

beforeAll(() => {
  localDb.init();
  settingsStore.init();
  historyService.init();
});

beforeEach(() => {
  historyService.clear();
  settingsStore.resetAll();
  for (const id of historyService.getParkedExpenseIds()) historyService.unparkExpense(id);
});

describe('history storage', () => {
  it('records and reads back a result', () => {
    historyService.recordResult(row({ categoryName: 'Groceries', confidence: 0.9, source: 'llm' }));
    const { rows, total } = historyService.getHistory();
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({ title: 'Aldi', category_name: 'Groceries', source: 'llm' });
  });

  it('creates the indexes the history view depends on', () => {
    const indexes = localDb
      .get()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='history'")
      .all()
      .map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_history_processed_at',
      'idx_history_expense_id',
      'idx_history_status',
    ]));
  });
});

describe('filtering and paging', () => {
  beforeEach(() => {
    historyService.recordResult(row({ expenseId: 'a', title: 'Rewe Markt', status: 'applied' }));
    historyService.recordResult(row({ expenseId: 'b', title: 'Shell Tanken', status: 'low_confidence' }));
    historyService.recordResult(row({ expenseId: 'c', title: 'Kino Abend', status: 'error' }));
  });

  it('filters by status', () => {
    expect(historyService.getHistory({ status: 'error' }).total).toBe(1);
  });

  it('searches the title case-insensitively', () => {
    expect(historyService.getHistory({ search: 'shell' }).rows[0].title).toBe('Shell Tanken');
  });

  it('pages without changing the reported total', () => {
    const page = historyService.getHistory({ limit: 2, offset: 0 });
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(historyService.getHistory({ limit: 2, offset: 2 }).rows).toHaveLength(1);
  });
});

describe('attempt state', () => {
  it('counts only retryable attempts', () => {
    historyService.recordResult(row({ status: 'low_confidence' }));
    historyService.recordResult(row({ status: 'error' }));
    historyService.recordResult(row({ status: 'applied' }));

    const state = historyService.getAttemptState().get('e-1');
    expect(state.attempts).toBe(2);
    expect(state.hoursSinceLast).toBeLessThan(1);
  });

  it('reports no state for an expense that was never attempted', () => {
    expect(historyService.getAttemptState().get('unknown')).toBeUndefined();
  });
});

describe('parking', () => {
  it('parks and un-parks an expense', () => {
    historyService.parkExpense('e-1', 'gave up');
    expect(historyService.getParkedExpenseIds()).toContain('e-1');
    expect(historyService.unparkExpense('e-1')).toBe(true);
    expect(historyService.getParkedExpenseIds()).not.toContain('e-1');
  });

  it('marks parked rows in the history view', () => {
    historyService.recordResult(row({ status: 'low_confidence' }));
    historyService.parkExpense('e-1', 'gave up');
    expect(historyService.getHistory().rows[0].is_parked).toBe(1);
  });
});

describe('stats', () => {
  it('breaks results down by status and source', () => {
    historyService.recordResult(row({ status: 'applied', source: 'wordlist', durationMs: 5 }));
    historyService.recordResult(row({ status: 'applied', source: 'llm', durationMs: 2000 }));
    historyService.recordResult(row({ status: 'error' }));

    expect(historyService.getStats()).toMatchObject({
      total: 3, applied: 2, errors: 1, viaWordList: 1, viaLlm: 1, avgLlmMs: 2000,
    });
  });
});

describe('corrections', () => {
  it('pairs a manual correction with the suggestion it replaced', () => {
    historyService.recordResult(row({ status: 'low_confidence', categoryName: 'Movies', source: 'llm' }));
    historyService.recordResult(row({ status: 'manual', categoryName: 'Groceries', source: 'manual' }));

    const [correction] = historyService.getCorrections();
    expect(correction).toMatchObject({ suggested: 'Movies', corrected_to: 'Groceries', suggested_source: 'llm' });
  });

  it('ignores a manual entry that merely confirmed the suggestion', () => {
    historyService.recordResult(row({ status: 'applied', categoryName: 'Groceries', source: 'llm' }));
    historyService.recordResult(row({ status: 'manual', categoryName: 'Groceries', source: 'manual' }));
    expect(historyService.getCorrections()).toHaveLength(0);
  });
});

describe('retention', () => {
  it('deletes rows older than the retention window', () => {
    historyService.recordResult(row());
    localDb.get().prepare("UPDATE history SET processed_at = datetime('now', '-120 days')").run();
    historyService.recordResult(row({ expenseId: 'fresh' }));

    settingsStore.setMany({ 'history.retentionDays': 90 });
    expect(historyService.prune()).toBe(1);
    expect(historyService.getHistory().total).toBe(1);
  });

  it('honours a shortened retention window', () => {
    historyService.recordResult(row());
    localDb.get().prepare("UPDATE history SET processed_at = datetime('now', '-5 days')").run();

    settingsStore.setMany({ 'history.retentionDays': 1 });
    expect(historyService.prune()).toBe(1);
  });
});
