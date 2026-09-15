'use strict';

const cron = require('node-cron');
const settingsStore = require('./settingsStore');
const categorizationService = require('./services/categorizationService');

let task = null;
let currentExpression = null;
let lastTickAt = null;
// Whether start() has ever been called in this process. `reload` must not be
// able to bring a scheduler to life in a process that deliberately never
// started one (a test run, or the app imported as a module).
let started = false;

function start() {
  stop();
  started = true;

  if (!settingsStore.get('scheduler.enabled')) {
    console.log('[Scheduler] Disabled.');
    return false;
  }

  const expression = settingsStore.get('scheduler.cronExpression');
  if (!cron.validate(expression)) {
    console.error(`[Scheduler] Invalid cron expression: "${expression}". Not started.`);
    return false;
  }

  task = cron.schedule(expression, async () => {
    lastTickAt = new Date().toISOString();
    console.log(`[Scheduler] Triggered at ${lastTickAt}`);
    try {
      // runBatch refuses to overlap with an in-flight run, so a slow batch
      // cannot be doubled up by the next tick or by the UI's Run button.
      await categorizationService.runBatch();
    } catch (err) {
      console.error('[Scheduler] Batch run failed:', err.message);
    }
  });

  currentExpression = expression;
  console.log(`[Scheduler] Started. Cron: "${expression}"`);
  return true;
}

function stop() {
  if (task) {
    task.stop();
    task = null;
    currentExpression = null;
    console.log('[Scheduler] Stopped.');
  }
}

/** Forget that the scheduler was ever started. Used by tests. */
function reset() {
  stop();
  started = false;
}

/**
 * Re-apply scheduler settings to a running scheduler.
 * A no-op if the scheduler was never started, or if nothing relevant changed.
 */
function reload() {
  if (!started) return false;
  const enabled = settingsStore.get('scheduler.enabled');
  const expression = settingsStore.get('scheduler.cronExpression');
  if (enabled === !!task && expression === currentExpression) return false;
  console.log('[Scheduler] Settings changed — reloading.');
  return start();
}

function status() {
  return {
    enabled: settingsStore.get('scheduler.enabled'),
    running: task !== null,
    cron: currentExpression || settingsStore.get('scheduler.cronExpression'),
    lastTickAt,
    batchRunning: categorizationService.isRunning(),
    lastRun: categorizationService.getLastRunSummary(),
  };
}

module.exports = { start, stop, reset, reload, status };
