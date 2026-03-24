'use strict';

const axios = require('axios');
jest.mock('axios');
const mockPost = jest.fn();
const mockGet = jest.fn();
axios.create.mockReturnValue({ post: mockPost, get: mockGet });
jest.mock('../src/services/historyService', () => ({
  getCategorizationPromptTemplate: jest.fn(),
  getDeterministicCategoryRules: jest.fn(() => []),
}));

const {
  buildPrompt,
  suggestCategory,
  extractFirstJsonObject,
  stripThinkingTags,
  getRawModelText,
  isGroceryLikeCategory,
  applyGroceryMerchantOverride,
  applyFurnitureTitleOverride,
  applyTitleSemanticGuard,
} = require('../src/services/ollamaService');
const historyService = require('../src/services/historyService');

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

  beforeEach(() => {
    historyService.getCategorizationPromptTemplate.mockReturnValue(
      jest.requireActual('../src/services/historyService').DEFAULT_CATEGORY_PROMPT_TEMPLATE
    );
  });

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

  it('lists all categories with their ids in strict ID format', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    CATEGORIES.forEach((c) => {
      expect(prompt).toContain(`[ID: ${c.id}]`);
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
    expect(prompt).toContain('categoryName must exactly match one list entry name');
    expect(prompt).toContain('No markdown, no extra keys');
  });

  it('includes explicit German-language guidance', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('often in German');
    expect(prompt).toContain('Lidl, Rewe, Edeka, Aldi, Kaufland, Tankstelle');
    expect(prompt).toContain('Interpret German context correctly');
  });

  it('includes few-shot examples for Edeka and Tankstelle with correct ID-name mapping', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('Few-shot examples');
    expect(prompt).toContain('Input expense title: "Edeka"');
    expect(prompt).toContain('"categoryName": "Groceries"');
    expect(prompt).toContain('"categoryId": 1');
    expect(prompt).toContain('Input expense title: "Tankstelle"');
    expect(prompt).toContain('"categoryName": "Fuel"');
    expect(prompt).toContain('"categoryId": 3');
  });

  it('restricts categoryName to the provided list entries', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('Never invent or alter category names');
    expect(prompt).toContain('"Groceries"');
    expect(prompt).toContain('"Restaurants"');
    expect(prompt).toContain('"Fuel"');
    expect(prompt).toContain('"Public Transit"');
    expect(prompt).toContain('"Movies"');
  });

  it('adds explicit guidance to avoid food categories for furniture-like titles', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('For household/furniture item titles');
    expect(prompt).toContain('Schrank, Tisch, Stuhl');
    expect(prompt).toContain('"Groceries"');
    expect(prompt).toContain('"Restaurants"');
  });

  it('uses runtime category IDs in few-shot examples (no hardcoded IDs)', () => {
    const customCategories = [
      { id: 11, grouping: 'Food', name: 'Groceries' },
      { id: 42, grouping: 'Transport', name: 'Fuel' },
    ];
    const prompt = buildPrompt(baseExpense, customCategories);
    expect(prompt).toContain('"categoryName": "Groceries"');
    expect(prompt).toContain('"categoryId": 11');
    expect(prompt).toContain('"categoryName": "Fuel"');
    expect(prompt).toContain('"categoryId": 42');
  });

  it('omits few-shot examples when insufficient distinct categories exist', () => {
    const oneCategory = [{ id: 9, grouping: 'Misc', name: 'Other' }];
    const prompt = buildPrompt(baseExpense, oneCategory);
    expect(prompt).not.toContain('Few-shot examples');
    expect(prompt).toContain('Choose exactly one category from the provided list');
  });

  it('requires reasoning first and categoryName before categoryId in JSON output', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('JSON key order is mandatory');
    expect(prompt).toContain('"reasoning" first, then "categoryName", then "categoryId"');
    const outputFormatSection = prompt.slice(prompt.lastIndexOf('{\n  "reasoning": "<short explanation>"'));
    const reasoningIdx = outputFormatSection.indexOf('"reasoning":');
    const categoryNameIdx = outputFormatSection.indexOf('"categoryName":');
    const categoryIdIdx = outputFormatSection.indexOf('"categoryId":');
    expect(reasoningIdx).toBeGreaterThan(-1);
    expect(categoryNameIdx).toBeGreaterThan(reasoningIdx);
    expect(categoryIdIdx).toBeGreaterThan(categoryNameIdx);
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
    historyService.getCategorizationPromptTemplate.mockReturnValue(
      jest.requireActual('../src/services/historyService').DEFAULT_CATEGORY_PROMPT_TEMPLATE
    );
    historyService.getDeterministicCategoryRules.mockReturnValue([]);
  });

  it('uses JSON response format and returns parsed suggestion', async () => {
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
    expect(payload.format).toBe('json');
  });

  it('parses JSON from markdown/conversational wrapper text', async () => {
    mockPost.mockResolvedValue({
      data: {
        response:
          'Sure, here is the result:\n```json\n{"reasoning":"Lidl is a grocery merchant.","categoryName":"Groceries","categoryId":1,"confidence":0.8}\n```\nAnything else?',
      },
    });

    const res = await suggestCategory(
      { id: 'exp-2b', title: 'Lidl', amount: 5000, notes: '', currency: 'EUR' },
      CATEGORIES
    );

    expect(res.categoryId).toBe(1);
    expect(res.categoryName).toBe('Groceries');
    expect(res.confidence).toBe(0.8);
  });

  it('parses JSON when model emits <think> wrapper before answer', async () => {
    mockPost.mockResolvedValue({
      data: {
        response:
          '<think>I should reason step by step here.</think>\n```json\n{"reasoning":"Merchant is grocery.","categoryName":"Groceries","categoryId":1,"confidence":0.77}\n```',
      },
    });

    const res = await suggestCategory(
      { id: 'exp-2c', title: 'Rewe', amount: 5100, notes: '', currency: 'EUR' },
      CATEGORIES
    );

    expect(res.categoryId).toBe(1);
    expect(res.categoryName).toBe('Groceries');
    expect(res.confidence).toBe(0.77);
  });

  it('parses nested JSON string response payloads', async () => {
    mockPost.mockResolvedValue({
      data: {
        response: '"{\\"reasoning\\":\\"double encoded\\",\\"categoryName\\":\\"Fuel\\",\\"categoryId\\":3,\\"confidence\\":0.66}"',
      },
    });

    const res = await suggestCategory(
      { id: 'exp-2d', title: 'Tankstelle', amount: 3300, notes: '', currency: 'EUR' },
      CATEGORIES
    );

    expect(res.categoryId).toBe(3);
    expect(res.categoryName).toBe('Fuel');
    expect(res.confidence).toBe(0.66);
  });

  it('reads raw text from chat-style message.content response shape', async () => {
    mockPost.mockResolvedValue({
      data: {
        message: {
          content:
            '<think>analysis</think>{"reasoning":"chat shape","categoryName":"Groceries","categoryId":1,"confidence":0.61}',
        },
      },
    });

    const res = await suggestCategory(
      { id: 'exp-2e', title: 'Aldi', amount: 1800, notes: '', currency: 'EUR' },
      CATEGORIES
    );

    expect(res.categoryId).toBe(1);
    expect(res.categoryName).toBe('Groceries');
    expect(res.confidence).toBe(0.61);
  });

  it('repairs mismatched categoryId by trusting categoryName from allowed categories', async () => {
    mockPost.mockResolvedValue({
      data: {
        response: JSON.stringify({
          categoryId: 2,
          categoryName: 'Fuel',
          confidence: 0.7,
          reasoning: 'example',
        }),
      },
    });

    const res = await suggestCategory(
      { id: 'exp-3', title: 'Miles', amount: 2500, notes: null, currency: 'EUR' },
      CATEGORIES
    );

    expect(res.categoryName).toBe('Fuel');
    expect(res.categoryId).toBe(3);
    expect(res.confidence).toBe(0.7);
  });

  it('rejects hallucinated categoryName that is not in provided categories', async () => {
    mockPost.mockResolvedValue({
      data: {
        response: JSON.stringify({
          categoryId: 12,
          categoryName: 'Transportation',
          confidence: 0.74,
          reasoning: 'car sharing',
        }),
      },
    });

    await expect(
      suggestCategory(
        { id: 'exp-3b', title: 'Miles', amount: 2500, notes: null, currency: 'EUR' },
        CATEGORIES
      )
    ).rejects.toThrow('invalid category reference');
  });

  it('repairs mismatched categoryName by trusting valid categoryId from allowed categories', async () => {
    mockPost.mockResolvedValue({
      data: {
        response: JSON.stringify({
          categoryId: 3,
          categoryName: 'Transportation',
          confidence: 0.74,
          reasoning: 'car sharing',
        }),
      },
    });

    const res = await suggestCategory(
      { id: 'exp-3c', title: 'Miles', amount: 2500, notes: null, currency: 'EUR' },
      CATEGORIES
    );

    expect(res.categoryId).toBe(3);
    expect(res.categoryName).toBe('Fuel');
    expect(res.confidence).toBe(0.74);
  });

  it('down-ranks overconfident non-home suggestion for furniture-like title', async () => {
    const categories = [
      { id: 1, grouping: 'Food & Drink', name: 'Groceries' },
      { id: 5, grouping: 'Entertainment', name: 'Entertainment' },
    ];
    mockPost.mockResolvedValue({
      data: {
        response: JSON.stringify({
          categoryId: 5,
          categoryName: 'Entertainment',
          confidence: 0.9,
          reasoning: 'Category matches title and German context',
        }),
      },
    });

    const res = await suggestCategory(
      { id: 'exp-4', title: 'Schrank', amount: 8000, notes: '', currency: 'EUR' },
      categories
    );

    expect(res.categoryId).toBe(5);
    expect(res.categoryName).toBe('Entertainment');
    expect(res.confidence).toBe(0.39);
    expect(res.reasoning).toContain('Heuristic note');
  });

  it('maps Schrank suggestion to Möbel/Furniture category when available', async () => {
    const categories = [
      { id: 5, grouping: 'Entertainment', name: 'Entertainment' },
      { id: 9, grouping: 'Home', name: 'Möbel' },
    ];
    mockPost.mockResolvedValue({
      data: {
        response: JSON.stringify({
          categoryId: 5,
          categoryName: 'Entertainment',
          confidence: 0.9,
          reasoning: 'Category matches title and German context',
        }),
      },
    });

    const res = await suggestCategory(
      { id: 'exp-5', title: 'Schrank', amount: 8000, notes: '', currency: 'EUR' },
      categories
    );

    expect(res.categoryId).toBe(9);
    expect(res.categoryName).toBe('Möbel');
    expect(res.confidence).toBe(0.9);
    expect(res.reasoning).toContain('mapped to "Möbel"');
  });

  it('maps IKEA suggestion to furniture category when available', async () => {
    const categories = [
      { id: 2, grouping: 'Entertainment', name: 'Movies' },
      { id: 7, grouping: 'Home', name: 'Furniture' },
    ];
    mockPost.mockResolvedValue({
      data: {
        response: JSON.stringify({
          categoryId: 2,
          categoryName: 'Movies',
          confidence: 0.72,
          reasoning: 'guess',
        }),
      },
    });

    const res = await suggestCategory(
      { id: 'exp-6', title: 'IKEA', amount: 12000, notes: '', currency: 'EUR' },
      categories
    );

    expect(res.categoryId).toBe(7);
    expect(res.categoryName).toBe('Furniture');
    expect(res.confidence).toBe(0.72);
  });

  it('maps Lidl suggestion to groceries category when available', async () => {
    const categories = [
      { id: 2, grouping: 'Entertainment', name: 'Entertainment' },
      { id: 11, grouping: 'Food & Drink', name: 'Groceries' },
    ];
    mockPost.mockResolvedValue({
      data: {
        response: JSON.stringify({
          categoryId: 2,
          categoryName: 'Entertainment',
          confidence: 0.8,
          reasoning: 'Lidl is a grocery store, a type of food and drink category.',
        }),
      },
    });

    const res = await suggestCategory(
      { id: 'exp-7', title: 'Lidl', amount: 2332, notes: '', currency: 'EUR' },
      categories
    );

    expect(res.categoryId).toBe(11);
    expect(res.categoryName).toBe('Groceries');
    expect(res.confidence).toBe(0.8);
    expect(res.reasoning).toContain('known grocery merchant');
  });

  it('uses deterministic rule match before LLM call', async () => {
    historyService.getDeterministicCategoryRules.mockReturnValue([
      { keyword: 'lidl', categoryPattern: 'grocer|grocery', reasoning: 'Rule match' },
    ]);
    const categories = [
      { id: 2, grouping: 'Entertainment', name: 'Entertainment' },
      { id: 11, grouping: 'Food & Drink', name: 'Groceries' },
    ];
    const res = await suggestCategory(
      { id: 'exp-rule-1', title: 'Shopping at Lidl', amount: 2332, notes: '', currency: 'EUR' },
      categories
    );

    expect(res).toEqual({
      categoryId: 11,
      categoryName: 'Groceries',
      confidence: 0.99,
      reasoning: 'Rule match',
    });
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('ollamaService.applyTitleSemanticGuard', () => {
  it('keeps confidence for furniture-like title when selected category is home-like', () => {
    const suggestion = {
      categoryId: 8,
      categoryName: 'Furniture',
      confidence: 0.9,
      reasoning: 'Looks like household expense',
    };
    const categories = [{ id: 8, grouping: 'Home', name: 'Furniture' }];
    const guarded = applyTitleSemanticGuard({ title: 'Schrank' }, suggestion, categories);
    expect(guarded.confidence).toBe(0.9);
    expect(guarded.reasoning).toBe('Looks like household expense');
  });
});

describe('ollamaService.applyFurnitureTitleOverride', () => {
  it('does not change suggestion when no furniture category exists', () => {
    const suggestion = {
      categoryId: 2,
      categoryName: 'Entertainment',
      confidence: 0.8,
      reasoning: 'model guess',
    };
    const categories = [{ id: 2, grouping: 'Entertainment', name: 'Entertainment' }];
    const out = applyFurnitureTitleOverride({ title: 'Schrank' }, suggestion, categories);
    expect(out).toEqual(suggestion);
  });
});

describe('ollamaService.isGroceryLikeCategory', () => {
  it('matches grocery category and excludes restaurants', () => {
    expect(isGroceryLikeCategory({ grouping: 'Food & Drink', name: 'Groceries' })).toBe(true);
    expect(isGroceryLikeCategory({ grouping: 'Food & Drink', name: 'Restaurants' })).toBe(false);
  });
});

describe('ollamaService.applyGroceryMerchantOverride', () => {
  it('maps known grocery merchant title from entertainment to groceries', () => {
    const suggestion = {
      categoryId: 2,
      categoryName: 'Entertainment',
      confidence: 0.8,
      reasoning: 'Lidl is a grocery store',
    };
    const categories = [
      { id: 2, grouping: 'Entertainment', name: 'Entertainment' },
      { id: 11, grouping: 'Food & Drink', name: 'Groceries' },
    ];
    const out = applyGroceryMerchantOverride({ title: 'Lidl' }, suggestion, categories);
    expect(out.categoryId).toBe(11);
    expect(out.categoryName).toBe('Groceries');
  });

  it('matches merchant keywords at end of title', () => {
    const suggestion = {
      categoryId: 2,
      categoryName: 'Entertainment',
      confidence: 0.8,
      reasoning: 'model guess',
    };
    const categories = [
      { id: 2, grouping: 'Entertainment', name: 'Entertainment' },
      { id: 11, grouping: 'Food & Drink', name: 'Groceries' },
    ];
    const out = applyGroceryMerchantOverride({ title: 'Shopping at Lidl' }, suggestion, categories);
    expect(out.categoryId).toBe(11);
    expect(out.categoryName).toBe('Groceries');
  });
});

describe('ollamaService.extractFirstJsonObject', () => {
  it('extracts first complete object from fenced conversational output', () => {
    const raw =
      'I can help with that.\n```json\n{"reasoning":"ok","categoryName":"Groceries","categoryId":1,"confidence":0.7}\n```\nDone.';
    expect(extractFirstJsonObject(raw)).toBe(
      '{"reasoning":"ok","categoryName":"Groceries","categoryId":1,"confidence":0.7}'
    );
  });

  it('ignores braces inside JSON string fields', () => {
    const raw =
      'prefix {"reasoning":"text with {brace} inside","categoryName":"Groceries","categoryId":1,"confidence":0.7} suffix';
    expect(extractFirstJsonObject(raw)).toBe(
      '{"reasoning":"text with {brace} inside","categoryName":"Groceries","categoryId":1,"confidence":0.7}'
    );
  });

  it('removes think tags and returns first complete JSON object', () => {
    const raw =
      '<think>chain of thought</think> Before output {"reasoning":"ok","categoryName":"Fuel","categoryId":3,"confidence":0.71} trailing';
    expect(extractFirstJsonObject(raw)).toBe(
      '{"reasoning":"ok","categoryName":"Fuel","categoryId":3,"confidence":0.71}'
    );
  });
});

describe('ollamaService.stripThinkingTags', () => {
  it('removes think blocks while leaving remaining text intact', () => {
    expect(stripThinkingTags('<think>abc</think> {"a":1}')).toBe('{"a":1}');
  });
});

describe('ollamaService.getRawModelText', () => {
  it('prefers data.response when present', () => {
    expect(getRawModelText({ response: 'abc', message: { content: 'ignored' } })).toBe('abc');
  });

  it('falls back to chat-style data.message.content', () => {
    expect(getRawModelText({ message: { content: 'xyz' } })).toBe('xyz');
  });
});
