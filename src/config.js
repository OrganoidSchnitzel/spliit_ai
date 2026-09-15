'use strict';

/**
 * Static configuration, read from the environment once at boot.
 *
 * Every value is validated here rather than at the point of use: a bad value
 * should stop the process with a clear message, not silently degrade the
 * behaviour of the categorizer hours later.
 *
 * Values marked "runtime-overridable" can be changed from the UI at runtime;
 * the environment only supplies their default. See src/settingsStore.js.
 */

class ConfigError extends Error {}

/**
 * Parse a number, accepting both `0.6` and the German `0,6`.
 * @param {string} name - Env var name, used in error messages
 * @param {any} raw
 * @param {{ min: number, max: number, integer?: boolean }} opts
 */
function parseNumber(name, raw, { min, max, integer = false }) {
  const normalized = String(raw).trim().replace(',', '.');
  const value = Number(normalized);

  if (normalized === '' || !Number.isFinite(value)) {
    throw new ConfigError(`${name}: "${raw}" is not a number (expected ${min}–${max})`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new ConfigError(`${name}: "${raw}" must be a whole number`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`${name}: ${value} is out of range (expected ${min}–${max})`);
  }
  return value;
}

/**
 * Parse a boolean from the usual spellings. Anything else is an error rather
 * than a silent `false`.
 */
function parseBoolean(name, raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new ConfigError(`${name}: "${raw}" is not a boolean (expected true/false)`);
}

function parseUrl(name, raw, fallback) {
  const value = String(raw ?? fallback).trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ConfigError(`${name}: "${raw}" must be an http(s) URL`);
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`${name}: "${raw}" is not a valid URL`);
  }
  return value;
}

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

/**
 * Read an environment variable, treating an empty string as "not set".
 *
 * Docker UIs — Unraid's template editor in particular — pass unset optional
 * fields as empty strings rather than omitting them. `??` alone does not catch
 * that, so `PORT=""` used to reach the number parser and abort startup with
 * "not a number" for a variable the user never filled in.
 */
function read(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed === '' ? undefined : trimmed;
}

function build(env) {
  const errors = [];
  const get = (name, fallback) => {
    const value = read(env, name);
    return value === undefined ? fallback : value;
  };
  const attempt = (fn, fallback) => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ConfigError) {
        errors.push(err.message);
        return fallback;
      }
      throw err;
    }
  };

  const cfg = {
    port: attempt(
      () => parseNumber('PORT', get('PORT', '3000'), { min: 1, max: 65535, integer: true }),
      3000
    ),

    // Optional shared secret. When set, every /api request must send it as
    // `X-Api-Token` or `Authorization: Bearer <token>`.
    apiToken: read(env, 'API_TOKEN') || null,

    logLevel: (() => {
      const raw = get('LOG_LEVEL', 'info').toLowerCase();
      if (!LOG_LEVELS.includes(raw)) {
        errors.push(`LOG_LEVEL: "${raw}" is not one of ${LOG_LEVELS.join(', ')}`);
        return 'info';
      }
      return raw;
    })(),

    // PostgreSQL (Spliit database)
    database: {
      host: get('DB_HOST', 'localhost'),
      port: attempt(
        () => parseNumber('DB_PORT', get('DB_PORT', '5432'), { min: 1, max: 65535, integer: true }),
        5432
      ),
      name: get('DB_NAME', 'spliit'),
      user: get('DB_USER', 'postgres'),
      password: env.DB_PASSWORD || '',
      ssl: attempt(() => parseBoolean('DB_SSL', read(env, 'DB_SSL'), false), false),
    },

    // Ollama (local LLM)
    ollama: {
      baseUrl: attempt(
        () => parseUrl('OLLAMA_BASE_URL', get('OLLAMA_BASE_URL', 'http://localhost:11434'), 'http://localhost:11434'),
        'http://localhost:11434'
      ),
      model: get('OLLAMA_MODEL', 'llama3.2'),
      timeoutMs: attempt(
        () =>
          parseNumber('OLLAMA_TIMEOUT_MS', get('OLLAMA_TIMEOUT_MS', '60000'), {
            min: 1000,
            max: 600000,
            integer: true,
          }),
        60000
      ),
      // How long Ollama keeps the model resident after a request. The default
      // (5m) is shorter than the default scheduler interval (15m), which means
      // the model is evicted and re-read from disk before every batch.
      keepAlive: get('OLLAMA_KEEP_ALIVE', '30m'),
      temperature: attempt(
        () => parseNumber('OLLAMA_TEMPERATURE', get('OLLAMA_TEMPERATURE', '0'), { min: 0, max: 2 }),
        0
      ),
      numPredict: attempt(
        () =>
          parseNumber('OLLAMA_NUM_PREDICT', get('OLLAMA_NUM_PREDICT', '256'), {
            min: 32,
            max: 4096,
            integer: true,
          }),
        256
      ),
      numCtx: attempt(
        () =>
          parseNumber('OLLAMA_NUM_CTX', get('OLLAMA_NUM_CTX', '2048'), {
            min: 512,
            max: 32768,
            integer: true,
          }),
        2048
      ),
      // Retries for transient failures (connection reset, 5xx, timeout).
      maxRetries: attempt(
        () =>
          parseNumber('OLLAMA_MAX_RETRIES', get('OLLAMA_MAX_RETRIES', '2'), {
            min: 0,
            max: 5,
            integer: true,
          }),
        2
      ),
      // Ask Ollama to constrain decoding to the response schema instead of
      // generic JSON mode. Disable for Ollama < 0.5.
      useStructuredOutput: attempt(
        () => parseBoolean('OLLAMA_STRUCTURED_OUTPUT', read(env, 'OLLAMA_STRUCTURED_OUTPUT'), true),
        true
      ),
      customPromptTemplate: read(env, 'OLLAMA_CUSTOM_PROMPT') || null,
    },

    // Minimum confidence (0–1) to auto-apply a suggested category.
    confidenceThreshold: attempt(
      () =>
        parseNumber('CONFIDENCE_THRESHOLD', get('CONFIDENCE_THRESHOLD', '0.6'), { min: 0, max: 1 }),
      0.6
    ),

    // Dry run: suggest and record, but never write to the Spliit database.
    dryRun: attempt(() => parseBoolean('DRY_RUN', read(env, 'DRY_RUN'), false), false),

    // Use the deterministic word lists before falling back to the LLM.
    wordListsEnabled: attempt(
      () => parseBoolean('WORDLISTS_ENABLED', read(env, 'WORDLISTS_ENABLED'), true),
      true
    ),

    scheduler: {
      enabled: attempt(
        () => parseBoolean('SCHEDULER_ENABLED', read(env, 'SCHEDULER_ENABLED'), true),
        true
      ),
      cronExpression: get('SCHEDULER_CRON', '*/15 * * * *'),
    },

    processing: {
      batchSize: attempt(
        () =>
          parseNumber('BATCH_SIZE', get('BATCH_SIZE', '10'), { min: 1, max: 500, integer: true }),
        10
      ),
      // Escalating wait before re-attempting an expense that did not reach the
      // confidence threshold, in hours. After the last step the expense is
      // "parked" and only retried on explicit request.
      retryBackoffHours: (() => {
        const raw = get('RETRY_BACKOFF_HOURS', '1,6,24');
        const parts = raw
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        const parsed = [];
        for (const part of parts) {
          const value = Number(part.replace(',', '.'));
          if (!Number.isFinite(value) || value <= 0) {
            errors.push(`RETRY_BACKOFF_HOURS: "${part}" is not a positive number`);
            return [1, 6, 24];
          }
          parsed.push(value);
        }
        return parsed.length ? parsed : [1, 6, 24];
      })(),
    },

    history: {
      retentionDays: attempt(
        () =>
          parseNumber('HISTORY_RETENTION_DAYS', get('HISTORY_RETENTION_DAYS', '90'), {
            min: 1,
            max: 3650,
            integer: true,
          }),
        90
      ),
    },
  };

  if (errors.length) {
    const err = new ConfigError(
      `Invalid configuration:\n  - ${errors.join('\n  - ')}\n` +
        'Fix the environment variables above and restart.'
    );
    err.details = errors;
    throw err;
  }

  return cfg;
}

const config = build(process.env);

// Exported for tests and for the settings store, which layers runtime
// overrides on top of these values.
config.build = build;
config.ConfigError = ConfigError;
config.parseNumber = parseNumber;
config.parseBoolean = parseBoolean;
config.readEnv = read;

module.exports = config;
