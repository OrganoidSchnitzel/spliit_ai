'use strict';

/**
 * Runtime settings, persisted in SQLite.
 *
 * Environment variables supply the defaults; anything saved here overrides
 * them and survives a restart. Previously the prompt template lived only in
 * `config.ollama.customPromptTemplate` and was lost on every container update,
 * while word-list edits were persisted — an inconsistency users read as a bug.
 */

const localDb = require('./localDb');
const config = require('./config');

/**
 * Schema for every runtime-editable setting.
 *
 * `type` drives both coercion and validation; `restart` marks settings whose
 * change needs to be propagated to a running component (the scheduler).
 */
const SCHEMA = {
  confidenceThreshold: {
    type: 'number',
    min: 0,
    max: 1,
    label: 'Confidence threshold',
    help: 'Minimum confidence required before a category is written to Spliit.',
    group: 'categorization',
  },
  dryRun: {
    type: 'boolean',
    label: 'Dry run',
    help: 'Suggest and log, but never write to the Spliit database.',
    group: 'categorization',
  },
  wordListsEnabled: {
    type: 'boolean',
    label: 'Use word lists',
    help: 'Try deterministic keyword matching before calling the LLM.',
    group: 'categorization',
  },
  autoApplyWordListMatches: {
    type: 'boolean',
    label: 'Auto-apply word-list matches',
    help: 'When off, keyword matches are recorded for review instead of applied.',
    group: 'categorization',
  },
  'ollama.model': {
    type: 'string',
    maxLength: 200,
    label: 'Model',
    help: 'Ollama model tag, e.g. qwen2.5:3b-instruct-q4_K_M.',
    group: 'ollama',
  },
  'ollama.baseUrl': {
    type: 'url',
    label: 'Base URL',
    help: 'Where the Ollama server is reachable.',
    group: 'ollama',
  },
  'ollama.timeoutMs': {
    type: 'number',
    min: 1000,
    max: 600000,
    integer: true,
    label: 'Request timeout (ms)',
    group: 'ollama',
  },
  'ollama.keepAlive': {
    type: 'string',
    maxLength: 20,
    label: 'Keep model loaded',
    help: 'How long Ollama keeps the model in memory, e.g. 30m. Should exceed the scheduler interval.',
    group: 'ollama',
  },
  'ollama.temperature': {
    type: 'number',
    min: 0,
    max: 2,
    label: 'Temperature',
    help: '0 makes categorization deterministic and repeatable.',
    group: 'ollama',
  },
  'ollama.numPredict': {
    type: 'number',
    min: 32,
    max: 4096,
    integer: true,
    label: 'Max tokens',
    help: 'Caps runaway generations that would otherwise only stop at the timeout.',
    group: 'ollama',
  },
  'ollama.numCtx': {
    type: 'number',
    min: 512,
    max: 32768,
    integer: true,
    label: 'Context size',
    group: 'ollama',
  },
  'ollama.useStructuredOutput': {
    type: 'boolean',
    label: 'Structured output',
    help: 'Constrain decoding to the response schema. Turn off for Ollama below 0.5.',
    group: 'ollama',
  },
  'ollama.customPromptTemplate': {
    type: 'text',
    maxLength: 20000,
    nullable: true,
    label: 'Custom prompt template',
    group: 'prompt',
  },
  'scheduler.enabled': {
    type: 'boolean',
    label: 'Scheduler enabled',
    group: 'scheduler',
    restart: true,
  },
  'scheduler.cronExpression': {
    type: 'cron',
    label: 'Schedule (cron)',
    help: 'Five-field cron expression. Default */15 * * * * runs every 15 minutes.',
    group: 'scheduler',
    restart: true,
  },
  'processing.batchSize': {
    type: 'number',
    min: 1,
    max: 500,
    integer: true,
    label: 'Batch size',
    help: 'Maximum expenses processed per run.',
    group: 'scheduler',
  },
  'processing.retryBackoffHours': {
    type: 'numberList',
    label: 'Retry backoff (hours)',
    help: 'Wait before re-attempting an expense that fell below the threshold. After the last step it is parked.',
    group: 'scheduler',
  },
  'history.retentionDays': {
    type: 'number',
    min: 1,
    max: 3650,
    integer: true,
    label: 'History retention (days)',
    group: 'history',
  },
};

let stmts = null;
const overrides = new Map();
const listeners = new Set();

function init() {
  const db = localDb.get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  stmts = {
    all: db.prepare('SELECT key, value FROM settings'),
    upsert: db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (@key, @value, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = datetime('now')
    `),
    remove: db.prepare('DELETE FROM settings WHERE key = ?'),
  };

  overrides.clear();
  for (const row of stmts.all.all()) {
    if (!SCHEMA[row.key]) continue; // ignore settings from a newer version
    try {
      overrides.set(row.key, JSON.parse(row.value));
    } catch {
      console.warn(`[Settings] Ignoring unreadable stored value for "${row.key}"`);
    }
  }
  return overrides.size;
}

/** Read a value from the static config by dotted path. */
function fromConfig(key) {
  return key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), config);
}

/**
 * Current effective value: the stored override if present, else the env-derived
 * default.
 * @param {string} key
 */
function get(key) {
  if (overrides.has(key)) return overrides.get(key);
  if (key === 'autoApplyWordListMatches') return true;
  return fromConfig(key);
}

/** Every effective setting, keyed by dotted path. */
function getAll() {
  const out = {};
  for (const key of Object.keys(SCHEMA)) out[key] = get(key);
  return out;
}

/** Which settings currently differ from their environment default. */
function getOverriddenKeys() {
  return [...overrides.keys()];
}

function coerce(key, raw) {
  const spec = SCHEMA[key];
  if (!spec) throw new Error(`Unknown setting "${key}"`);

  if (raw === null || raw === '') {
    if (spec.nullable) return null;
    throw new Error(`${spec.label || key} cannot be empty`);
  }

  switch (spec.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      return config.parseBoolean(key, raw, false);
    }
    case 'number': {
      return config.parseNumber(spec.label || key, raw, {
        min: spec.min,
        max: spec.max,
        integer: spec.integer,
      });
    }
    case 'numberList': {
      const parts = (Array.isArray(raw) ? raw : String(raw).split(','))
        .map((p) => String(p).trim())
        .filter(Boolean);
      if (!parts.length) throw new Error(`${spec.label || key} needs at least one value`);
      return parts.map((p) =>
        config.parseNumber(spec.label || key, p, { min: 0.01, max: 8760 })
      );
    }
    case 'url': {
      const value = String(raw).trim().replace(/\/+$/, '');
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error(`${spec.label || key} is not a valid URL`);
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`${spec.label || key} must be an http(s) URL`);
      }
      return value;
    }
    case 'cron': {
      const value = String(raw).trim();
      // Required lazily: node-cron is only needed to validate.
      const cron = require('node-cron');
      if (!cron.validate(value)) {
        throw new Error(`"${value}" is not a valid cron expression`);
      }
      return value;
    }
    case 'text':
    case 'string':
    default: {
      const value = String(raw);
      if (spec.maxLength && value.length > spec.maxLength) {
        throw new Error(`${spec.label || key} is longer than ${spec.maxLength} characters`);
      }
      const trimmed = spec.type === 'text' ? value : value.trim();
      if (!trimmed && !spec.nullable) throw new Error(`${spec.label || key} cannot be empty`);
      return trimmed;
    }
  }
}

/**
 * Validate and persist a batch of settings. All-or-nothing: if any value is
 * rejected, none are written.
 * @param {Record<string, any>} patch
 * @returns {{ changed: string[], requiresSchedulerReload: boolean }}
 */
function setMany(patch) {
  // These are client mistakes, so they must carry a 4xx rather than falling
  // through to the error middleware as an unexplained 500.
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw Object.assign(new Error('Expected an object of settings'), { statusCode: 400 });
  }

  const unknown = Object.keys(patch).filter((k) => !SCHEMA[k]);
  if (unknown.length) {
    throw Object.assign(new Error(`Unknown setting(s): ${unknown.join(', ')}`), { statusCode: 400 });
  }

  const coerced = {};
  const errors = [];
  for (const [key, raw] of Object.entries(patch)) {
    try {
      coerced[key] = coerce(key, raw);
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.statusCode = 400;
    throw err;
  }

  const changed = [];
  let requiresSchedulerReload = false;

  const db = localDb.get();
  db.transaction(() => {
    for (const [key, value] of Object.entries(coerced)) {
      const current = get(key);
      if (JSON.stringify(current) === JSON.stringify(value)) continue;
      stmts.upsert.run({ key, value: JSON.stringify(value) });
      overrides.set(key, value);
      changed.push(key);
      if (SCHEMA[key].restart) requiresSchedulerReload = true;
    }
  })();

  if (changed.length) notify(changed);
  return { changed, requiresSchedulerReload };
}

/**
 * Drop a stored override so the value falls back to the environment default.
 * @param {string} key
 */
function reset(key) {
  if (!SCHEMA[key]) {
    throw Object.assign(new Error(`Unknown setting "${key}"`), { statusCode: 404 });
  }
  if (!overrides.has(key)) return false;
  stmts.remove.run(key);
  overrides.delete(key);
  notify([key]);
  return true;
}

/** Reset every override at once. */
function resetAll() {
  const keys = [...overrides.keys()];
  if (!keys.length) return [];
  const db = localDb.get();
  db.transaction(() => {
    for (const key of keys) stmts.remove.run(key);
  })();
  overrides.clear();
  notify(keys);
  return keys;
}

function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(changed) {
  for (const listener of listeners) {
    try {
      listener(changed);
    } catch (err) {
      console.error('[Settings] change listener failed:', err.message);
    }
  }
}

/** Schema exposed to the UI so the settings form can render itself. */
function describe() {
  return Object.entries(SCHEMA).map(([key, spec]) => ({
    key,
    type: spec.type,
    label: spec.label || key,
    help: spec.help || null,
    group: spec.group,
    min: spec.min,
    max: spec.max,
    integer: !!spec.integer,
    nullable: !!spec.nullable,
    value: get(key),
    isOverridden: overrides.has(key),
    defaultValue: key === 'autoApplyWordListMatches' ? true : fromConfig(key),
  }));
}

module.exports = {
  init,
  get,
  getAll,
  getOverriddenKeys,
  setMany,
  reset,
  resetAll,
  onChange,
  describe,
  SCHEMA,
};
