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
