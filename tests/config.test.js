'use strict';

const { build, ConfigError } = require('../src/config');

describe('config validation', () => {
  it('accepts a German decimal comma instead of silently reading it as 0', () => {
    // parseFloat('0,7') is 0, which used to make every suggestion auto-apply.
    expect(build({ CONFIDENCE_THRESHOLD: '0,7' }).confidenceThreshold).toBe(0.7);
  });

  it('rejects a non-numeric batch size instead of producing LIMIT NaN', () => {
    expect(() => build({ BATCH_SIZE: 'ten' })).toThrow(/BATCH_SIZE/);
  });

  it('rejects an out-of-range confidence threshold', () => {
    expect(() => build({ CONFIDENCE_THRESHOLD: '5' })).toThrow(/out of range/);
  });

  it('rejects an unparseable boolean', () => {
    expect(() => build({ SCHEDULER_ENABLED: 'nope' })).toThrow(/not a boolean/);
  });

  it('accepts the usual boolean spellings', () => {
    expect(build({ DRY_RUN: 'yes' }).dryRun).toBe(true);
    expect(build({ DRY_RUN: 'off' }).dryRun).toBe(false);
    expect(build({}).dryRun).toBe(false);
  });

  it('rejects a malformed Ollama URL', () => {
    expect(() => build({ OLLAMA_BASE_URL: 'not a url' })).toThrow(/OLLAMA_BASE_URL/);
  });

  it('rejects a non-http Ollama URL', () => {
    expect(() => build({ OLLAMA_BASE_URL: 'ftp://host:11434' })).toThrow(/http\(s\)/);
  });

  it('strips a trailing slash from the Ollama URL', () => {
    expect(build({ OLLAMA_BASE_URL: 'http://ollama:11434/' }).ollama.baseUrl).toBe('http://ollama:11434');
  });

  it('reports every problem at once rather than one per restart', () => {
    let error;
    try {
      build({ BATCH_SIZE: 'ten', CONFIDENCE_THRESHOLD: '9', LOG_LEVEL: 'loud' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.details).toHaveLength(3);
  });

  it('parses the retry backoff into an ascending list of hours', () => {
    expect(build({ RETRY_BACKOFF_HOURS: '0.5, 2, 12' }).processing.retryBackoffHours).toEqual([0.5, 2, 12]);
  });

  it('defaults keep_alive above the default scheduler interval', () => {
    expect(build({}).ollama.keepAlive).toBe('30m');
  });
});

describe('empty environment variables', () => {
  // Docker UIs — Unraid's template editor especially — pass unset optional
  // fields as empty strings rather than omitting them. Treating those as a
  // validation error stopped containers from starting after an upgrade, with
  // no configuration change on the user's side.
  const NUMERIC = [
    'PORT', 'DB_PORT', 'CONFIDENCE_THRESHOLD', 'BATCH_SIZE', 'OLLAMA_TIMEOUT_MS',
    'OLLAMA_TEMPERATURE', 'OLLAMA_NUM_PREDICT', 'OLLAMA_NUM_CTX',
    'OLLAMA_MAX_RETRIES', 'HISTORY_RETENTION_DAYS',
  ];

  it.each(NUMERIC)('treats %s="" as unset', (name) => {
    expect(() => build({ [name]: '' })).not.toThrow();
  });

  it('treats an empty OLLAMA_BASE_URL as unset', () => {
    expect(build({ OLLAMA_BASE_URL: '' }).ollama.baseUrl).toBe('http://localhost:11434');
  });

  it('treats whitespace-only values as unset', () => {
    expect(build({ PORT: '   ', CONFIDENCE_THRESHOLD: ' ' }).port).toBe(3000);
  });

  it('starts with every optional variable empty at once', () => {
    const env = Object.fromEntries(
      [...NUMERIC, 'OLLAMA_BASE_URL', 'OLLAMA_MODEL', 'SCHEDULER_CRON', 'DB_HOST',
       'LOG_LEVEL', 'DRY_RUN', 'SCHEDULER_ENABLED', 'API_TOKEN', 'OLLAMA_KEEP_ALIVE',
       'RETRY_BACKOFF_HOURS', 'DB_SSL', 'WORDLISTS_ENABLED'].map((k) => [k, ''])
    );
    const cfg = build(env);
    expect(cfg.port).toBe(3000);
    expect(cfg.confidenceThreshold).toBe(0.6);
    expect(cfg.ollama.model).toBe('llama3.2');
    expect(cfg.apiToken).toBeNull();
    expect(cfg.scheduler.cronExpression).toBe('*/15 * * * *');
  });

  it('still rejects a value that is genuinely wrong', () => {
    // The point is to ignore blanks, not to stop validating.
    expect(() => build({ BATCH_SIZE: 'ten' })).toThrow(/BATCH_SIZE/);
    expect(() => build({ CONFIDENCE_THRESHOLD: '9' })).toThrow(/out of range/);
  });
});
