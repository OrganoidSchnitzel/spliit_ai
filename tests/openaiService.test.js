'use strict';

/**
 * Tests for the OpenAI-compatible AI service.
 * All HTTP calls are mocked via jest.mock('axios').
 */

jest.mock('../src/config', () => ({
  aiProvider: 'openai',
  openai: {
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    timeoutMs: 5000,
  },
  ollama: {
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2',
    timeoutMs: 5000,
  },
  confidenceThreshold: 0.6,
}));

// Intercept axios.create so we can control the instance
const mockGet  = jest.fn();
const mockPost = jest.fn();
jest.mock('axios', () => ({
  create: () => ({ get: mockGet, post: mockPost }),
}));

// openaiService imports axios and config at module load time – require AFTER mocks
const openaiService = require('../src/services/openaiService');

const CATEGORIES = [
  { id: 1, grouping: 'Food', name: 'Groceries' },
  { id: 2, grouping: 'Transport', name: 'Fuel' },
];

const EXPENSE = {
  id: 'e-42',
  title: 'REWE',
  amount: 1800,
  currency: 'EUR',
  notes: null,
};

const makeChoice = (content) => ({
  data: {
    choices: [{ message: { content } }],
  },
});

describe('openaiService.healthCheck', () => {
  it('returns ok=true with model list when endpoint responds', async () => {
    mockGet.mockResolvedValueOnce({ data: { data: [{ id: 'gpt-4o-mini' }] } });
    const result = await openaiService.healthCheck();
    expect(result.ok).toBe(true);
    expect(result.models).toContain('gpt-4o-mini');
  });

  it('returns ok=false on network error', async () => {
    mockGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await openaiService.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});

describe('openaiService.suggestCategory', () => {
  it('parses a valid response and returns the suggestion', async () => {
    mockPost.mockResolvedValueOnce(
      makeChoice(JSON.stringify({ categoryId: 1, confidence: 0.92, reasoning: 'Supermarket' }))
    );
    const result = await openaiService.suggestCategory(EXPENSE, CATEGORIES);
    expect(result.categoryId).toBe(1);
    expect(result.confidence).toBeCloseTo(0.92);
    expect(result.reasoning).toBe('Supermarket');
  });

  it('strips markdown code fences before parsing', async () => {
    mockPost.mockResolvedValueOnce(
      makeChoice('```json\n{"categoryId":2,"confidence":0.75,"reasoning":"fuel"}\n```')
    );
    const result = await openaiService.suggestCategory(EXPENSE, CATEGORIES);
    expect(result.categoryId).toBe(2);
  });

  it('throws when the response is not valid JSON', async () => {
    mockPost.mockResolvedValueOnce(makeChoice('sorry, I cannot help with that'));
    await expect(openaiService.suggestCategory(EXPENSE, CATEGORIES)).rejects.toThrow(
      /Failed to parse OpenAI response/
    );
  });

  it('throws when categoryId is not in the valid list', async () => {
    mockPost.mockResolvedValueOnce(
      makeChoice(JSON.stringify({ categoryId: 999, confidence: 0.8, reasoning: 'unknown' }))
    );
    await expect(openaiService.suggestCategory(EXPENSE, CATEGORIES)).rejects.toThrow(
      /not in the list of valid categories/
    );
  });

  it('throws when confidence is out of range', async () => {
    mockPost.mockResolvedValueOnce(
      makeChoice(JSON.stringify({ categoryId: 1, confidence: 1.5, reasoning: 'bad' }))
    );
    await expect(openaiService.suggestCategory(EXPENSE, CATEGORIES)).rejects.toThrow(
      /Invalid confidence/
    );
  });

  it('throws on network error with detail from response body', async () => {
    const axiosErr = new Error('Request failed');
    axiosErr.response = { data: { error: { message: 'Invalid API key' } } };
    mockPost.mockRejectedValueOnce(axiosErr);
    await expect(openaiService.suggestCategory(EXPENSE, CATEGORIES)).rejects.toThrow(
      /OpenAI request failed/
    );
  });
});
