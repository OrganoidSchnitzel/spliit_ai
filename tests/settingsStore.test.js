'use strict';

const localDb = require('../src/localDb');
const settingsStore = require('../src/settingsStore');
const config = require('../src/config');

beforeAll(() => {
  localDb.init();
  settingsStore.init();
});

beforeEach(() => settingsStore.resetAll());

describe('settingsStore', () => {
  it('falls back to the environment default when nothing is stored', () => {
    expect(settingsStore.get('confidenceThreshold')).toBe(config.confidenceThreshold);
  });

  it('persists an override and reports it as overridden', () => {
    settingsStore.setMany({ confidenceThreshold: 0.8 });
    expect(settingsStore.get('confidenceThreshold')).toBe(0.8);
    expect(settingsStore.getOverriddenKeys()).toContain('confidenceThreshold');
  });

  it('survives a reload of the store', () => {
    settingsStore.setMany({ 'ollama.model': 'qwen2.5:3b' });
    settingsStore.init();
    expect(settingsStore.get('ollama.model')).toBe('qwen2.5:3b');
  });

  it('coerces a German decimal comma', () => {
    settingsStore.setMany({ confidenceThreshold: '0,45' });
    expect(settingsStore.get('confidenceThreshold')).toBe(0.45);
  });

  it('writes nothing when any value in the batch is invalid', () => {
    expect(() =>
      settingsStore.setMany({ confidenceThreshold: 0.9, 'processing.batchSize': -4 })
    ).toThrow();
    expect(settingsStore.get('confidenceThreshold')).toBe(config.confidenceThreshold);
  });

  it('rejects an unknown key', () => {
    expect(() => settingsStore.setMany({ nope: 1 })).toThrow(/Unknown setting/);
  });

  it('rejects an invalid cron expression', () => {
    expect(() => settingsStore.setMany({ 'scheduler.cronExpression': 'not cron' })).toThrow(/cron/);
  });

  it('accepts a valid cron expression', () => {
    settingsStore.setMany({ 'scheduler.cronExpression': '0 */2 * * *' });
    expect(settingsStore.get('scheduler.cronExpression')).toBe('0 */2 * * *');
  });

  it('flags settings that need the scheduler restarted', () => {
    const res = settingsStore.setMany({ 'scheduler.cronExpression': '*/30 * * * *' });
    expect(res.requiresSchedulerReload).toBe(true);
  });

  it('does not flag a scheduler reload for unrelated settings', () => {
    expect(settingsStore.setMany({ dryRun: true }).requiresSchedulerReload).toBe(false);
  });

  it('reports no change when the value already matches', () => {
    settingsStore.setMany({ dryRun: true });
    expect(settingsStore.setMany({ dryRun: true }).changed).toEqual([]);
  });

  it('allows the prompt template to be cleared', () => {
    settingsStore.setMany({ 'ollama.customPromptTemplate': 'x {{title}} {{categories}}' });
    settingsStore.setMany({ 'ollama.customPromptTemplate': null });
    expect(settingsStore.get('ollama.customPromptTemplate')).toBeNull();
  });

  it('refuses to empty a non-nullable setting', () => {
    expect(() => settingsStore.setMany({ 'ollama.model': '' })).toThrow(/cannot be empty/);
  });

  it('parses a comma-separated backoff list', () => {
    settingsStore.setMany({ 'processing.retryBackoffHours': '2, 8, 48' });
    expect(settingsStore.get('processing.retryBackoffHours')).toEqual([2, 8, 48]);
  });

  it('notifies listeners about what changed', () => {
    const seen = [];
    const off = settingsStore.onChange((changed) => seen.push(...changed));
    settingsStore.setMany({ dryRun: true });
    off();
    expect(seen).toContain('dryRun');
  });

  it('describes every setting for the UI to render', () => {
    const described = settingsStore.describe();
    expect(described.length).toBeGreaterThan(10);
    expect(described[0]).toHaveProperty('label');
    expect(described[0]).toHaveProperty('group');
    expect(described[0]).toHaveProperty('value');
  });

  it('reverts a single override back to the environment default', () => {
    settingsStore.setMany({ confidenceThreshold: 0.99 });
    expect(settingsStore.reset('confidenceThreshold')).toBe(true);
    expect(settingsStore.get('confidenceThreshold')).toBe(config.confidenceThreshold);
  });
});
