'use strict';

describe('AIServiceFactory.getService', () => {
  afterEach(() => jest.resetModules());

  it('returns ollamaService when AI_PROVIDER=ollama', () => {
    jest.mock('../src/config', () => ({ aiProvider: 'ollama', ollama: {}, openai: {} }));
    const factory = require('../src/services/aiServiceFactory');
    const svc = factory.getService();
    expect(typeof svc.suggestCategory).toBe('function');
    expect(typeof svc.healthCheck).toBe('function');
  });

  it('returns openaiService when AI_PROVIDER=openai', () => {
    jest.mock('../src/config', () => ({ aiProvider: 'openai', ollama: {}, openai: { apiKey: '', baseUrl: '', model: '', timeoutMs: 5000 } }));
    const factory = require('../src/services/aiServiceFactory');
    const svc = factory.getService();
    expect(typeof svc.suggestCategory).toBe('function');
    expect(typeof svc.healthCheck).toBe('function');
  });

  it('falls back to ollamaService for unknown provider', () => {
    jest.mock('../src/config', () => ({ aiProvider: 'unknown', ollama: {}, openai: {} }));
    const factory = require('../src/services/aiServiceFactory');
    const svc = factory.getService();
    // Should not throw; should be a service with suggestCategory
    expect(typeof svc.suggestCategory).toBe('function');
  });
});
