'use strict';

const axios = require('axios');
jest.mock('axios');
const mockPost = jest.fn();
const mockGet = jest.fn();
axios.create.mockReturnValue({ post: mockPost, get: mockGet });

const { buildPrompt, suggestCategory } = require('../src/services/ollamaService');

const CATEGORIES = [
  { id: 1, grouping: 'Food & Drink', name: 'Groceries' },
  { id: 2, grouping: 'Food & Drink', name: 'Restaurants' },
  { id: 3, grouping: 'Transport', name: 'Fuel' },
  { id: 4, grouping: 'Transport', name: 'Public Transit' },
  { id: 5, grouping: 'Entertainment', name: 'Movies' },
];

describe('ollamaService.buildPrompt', () => {
  const baseExpense = {
    id: 'exp-1',
    title: 'Lidl groceries',
    amount: 4250,
    currency: 'EUR',
    notes: null,
  };

  it('includes the expense title', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('Lidl groceries');
  });

  it('converts amount from cents to display value', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('42.50');
  });

  it('includes the currency', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('EUR');
  });

  it('lists all categories with their ids', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    CATEGORIES.forEach((c) => {
      expect(prompt).toContain(`id ${c.id}`);
      expect(prompt).toContain(c.name);
      expect(prompt).toContain(c.grouping);
    });
  });

  it('omits notes section when notes are empty', () => {
    const prompt = buildPrompt({ ...baseExpense, notes: '' }, CATEGORIES);
    expect(prompt).not.toContain('Notes:');
  });

  it('includes notes when provided', () => {
    const prompt = buildPrompt({ ...baseExpense, notes: 'weekly shop' }, CATEGORIES);
    expect(prompt).toContain('Notes: weekly shop');
  });

  it('instructs the model to respond with JSON', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('"categoryId"');
    expect(prompt).toContain('"categoryName"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"reasoning"');
  });

  it('enforces categoryId/categoryName consistency and no extra keys', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('Choose exactly one category from the provided list');
    expect(prompt).toContain('categoryId and categoryName must refer to the same list entry');
    expect(prompt).toContain('No markdown, no extra keys');
  });

  it('includes explicit German-language guidance', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('often in German');
    expect(prompt).toContain('Edeka, Tankstelle');
    expect(prompt).toContain('Interpret German context correctly');
  });

  it('handles missing currency gracefully', () => {
    const prompt = buildPrompt({ ...baseExpense, currency: undefined }, CATEGORIES);
    expect(prompt).toContain('42.50');
    // Should still include the amount even without a currency symbol
    expect(typeof prompt).toBe('string');
  });
});

describe('ollamaService.suggestCategory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses strict schema format and returns parsed suggestion', async () => {
    mockPost.mockResolvedValue({
      data: {
        response: JSON.stringify({
          categoryId: 3,
          categoryName: 'Fuel',
          confidence: 0.86,
          reasoning: 'Tankstelle indicates fuel purchase.',
        }),
      },
    });

    const res = await suggestCategory(
      { id: 'exp-2', title: 'Tankstelle', amount: 5000, notes: '', currency: 'EUR' },
      CATEGORIES
    );

    expect(res).toEqual({
      categoryId: 3,
      categoryName: 'Fuel',
      confidence: 0.86,
      reasoning: 'Tankstelle indicates fuel purchase.',
    });

    const [, payload] = mockPost.mock.calls[0];
    expect(payload.format).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['categoryId', 'categoryName', 'confidence', 'reasoning'],
      properties: {
        categoryId: { type: 'integer' },
        categoryName: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reasoning: { type: 'string' },
      },
    });
  });

  it('rejects mismatched categoryId/categoryName', async () => {
    mockPost.mockResolvedValue({
      data: {
        response: JSON.stringify({
          categoryId: 2,
          categoryName: 'Movies',
          confidence: 0.7,
          reasoning: 'example',
        }),
      },
    });

    await expect(
      suggestCategory(
        { id: 'exp-3', title: 'Pizza', amount: 2500, notes: null, currency: 'EUR' },
        CATEGORIES
      )
    ).rejects.toThrow('mismatched categoryId/categoryName');
  });
});
