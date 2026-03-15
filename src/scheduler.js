'use strict';

const cron = require('node-cron');
const config = require('./config');
const categorizationService = require('./services/categorizationService');

let task = null;

function start() {
  if (!config.scheduler.enabled) {
    console.log('[Scheduler] Disabled via SCHEDULER_ENABLED=false');
    return;
  }

  if (!cron.validate(config.scheduler.cronExpression)) {
    console.error(
      `[Scheduler] Invalid cron expression: "${config.scheduler.cronExpression}". Scheduler not started.`
    );
    return;
  }

  task = cron.schedule(config.scheduler.cronExpression, async () => {
    console.log(`[Scheduler] Triggered at ${new Date().toISOString()}`);
    try {
      await categorizationService.runBatch();
    } catch (err) {
      console.error('[Scheduler] Batch run failed:', err.message);
    }
  });

  console.log(
    `[Scheduler] Started. Cron: "${config.scheduler.cronExpression}"`
  );
}

function stop() {
  if (task) {
    task.stop();
    task = null;
    console.log('[Scheduler] Stopped.');
  }
}

module.exports = { start, stop };
