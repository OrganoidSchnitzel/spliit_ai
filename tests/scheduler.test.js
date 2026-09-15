'use strict';

jest.mock('../src/services/categorizationService', () => ({
  runBatch: jest.fn().mockResolvedValue({}),
  isRunning: jest.fn(() => false),
  getLastRunSummary: jest.fn(() => null),
}));

const localDb = require('../src/localDb');
const settingsStore = require('../src/settingsStore');
const scheduler = require('../src/scheduler');

beforeAll(() => {
  localDb.init();
  settingsStore.init();
});

afterEach(() => {
  scheduler.reset();
  settingsStore.resetAll();
});

describe('scheduler', () => {
  it('starts with the configured cron expression', () => {
    expect(scheduler.start()).toBe(true);
    expect(scheduler.status()).toMatchObject({ running: true, cron: '*/15 * * * *' });
  });

  it('does not start when disabled', () => {
    settingsStore.setMany({ 'scheduler.enabled': false });
    expect(scheduler.start()).toBe(false);
    expect(scheduler.status().running).toBe(false);
  });

  it('refuses to start on an invalid expression rather than throwing', () => {
    // The settings store rejects bad cron, so this can only arrive from a bad
    // env var — which must not take the whole process down.
    const spy = jest.spyOn(settingsStore, 'get').mockImplementation((key) =>
      key === 'scheduler.cronExpression' ? 'not a cron' : true
    );
    expect(scheduler.start()).toBe(false);
    spy.mockRestore();
  });

  it('reload is a no-op when the scheduler was never started', () => {
    // Otherwise reverting an unrelated setting would spin up a cron task in a
    // process that deliberately runs without one.
    settingsStore.setMany({ 'scheduler.cronExpression': '0 * * * *' });
    expect(scheduler.reload()).toBe(false);
    expect(scheduler.status().running).toBe(false);
  });

  it('reload restarts a running scheduler when the expression changes', () => {
    scheduler.start();
    settingsStore.setMany({ 'scheduler.cronExpression': '0 */3 * * *' });
    expect(scheduler.reload()).toBe(true);
    expect(scheduler.status().cron).toBe('0 */3 * * *');
  });

  it('reload does nothing when the settings are unchanged', () => {
    scheduler.start();
    expect(scheduler.reload()).toBe(false);
  });

  it('reload stops a running scheduler that has been disabled', () => {
    scheduler.start();
    settingsStore.setMany({ 'scheduler.enabled': false });
    scheduler.reload();
    expect(scheduler.status().running).toBe(false);
  });

  it('stop is idempotent', () => {
    scheduler.start();
    scheduler.stop();
    scheduler.stop();
    expect(scheduler.status().running).toBe(false);
  });
});
