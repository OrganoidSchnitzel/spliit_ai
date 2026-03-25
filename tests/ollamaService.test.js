'use strict';

const axios = require('axios');
jest.mock('axios');
const mockPost = jest.fn();
const mockGet = jest.fn();
axios.create.mockReturnValue({ post: mockPost, get: mockGet });

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

  it('lists all categories with their ids in compact format', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    CATEGORIES.forEach((c) => {
      expect(prompt).toContain(`${c.id}:${c.name}`);
    });
  });

  it('omits notes section when notes are empty', () => {
    const prompt = buildPrompt({ ...baseExpense, notes: '' }, CATEGORIES);
    expect(prompt).not.toContain('Notes:');
  });

  it('includes notes when provided', () => {
    const prompt = buildPrompt({ ...baseExpense, notes: 'weekly shop' }, CATEGORIES);
    expect(prompt).toContain('Notes:weekly shop');
  });

  it('instructs the model to respond with JSON', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('"categoryId"');
    expect(prompt).toContain('"categoryName"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"reasoning"');
  });

  it('enforces categoryId/categoryName consistency', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('Pick ONE category ID from list');
    expect(prompt).toContain('"categoryName":"<exact name>"');
  });

  it('includes explicit German-language guidance', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('German context');
    expect(prompt).toContain('Lidl/Rewe/Edeka/Aldi');
  });

  it('uses optimized compact format without few-shot examples', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    // Optimized prompt doesn't include few-shot examples
    expect(prompt).not.toContain('Few-shot examples');
    // But includes essential rules
    expect(prompt).toContain('Rules:');
    expect(prompt).toContain('Match by merchant type');
  });

  it('restricts categoryName to the provided list entries', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    // Check categories are included in compact format
    expect(prompt).toContain('1:Groceries');
    expect(prompt).toContain('2:Restaurants');
    expect(prompt).toContain('3:Fuel');
    expect(prompt).toContain('4:Public Transit');
    expect(prompt).toContain('5:Movies');
  });

  it('includes furniture guidance in German context', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('IKEA/Möbel→furniture');
  });

  it('uses runtime category IDs in compact format', () => {
    const customCategories = [
      { id: 11, grouping: 'Food', name: 'Groceries' },
      { id: 42, grouping: 'Transport', name: 'Fuel' },
    ];
    const prompt = buildPrompt(baseExpense, customCategories);
    expect(prompt).toContain('11:Groceries');
    expect(prompt).toContain('42:Fuel');
  });

  it('works with single category', () => {
    const oneCategory = [{ id: 9, grouping: 'Misc', name: 'Other' }];
    const prompt = buildPrompt(baseExpense, oneCategory);
    expect(prompt).toContain('9:Other');
    expect(prompt).toContain('Pick ONE category ID from list');
  });

  it('specifies JSON output format with key order', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('Output format');
    expect(prompt).toContain('"reasoning"');
    expect(prompt).toContain('"categoryName"');
    expect(prompt).toContain('"categoryId"');
    expect(prompt).toContain('"confidence"');
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

  it('uses JSON response format and returns parsed suggestion', async () => {
    mockPost.mockResolvedValue({
            data: {
        response: JSON.stringify({
          categoryId: 3,
          categoryName: 'Fuel',
          confidence: 0.86,
          reasoning: 'Gas station purchase.',
        }),
      },
    });

    const res = await suggestCategory(
      { id: 'exp-2', title: 'Highway fuel', amount: 5000, notes: '', currency: 'EUR' },
      CATEGORIES
    );

    expect(res).toEqual({
      categoryId: 3,
      categoryName: 'Fuel',
      confidence: 0.86,
      reasoning: 'Gas station purchase.',
      source: 'llm',
    });

    const [, payload] = mockPost.mock.calls[0];
    expect(payload.format).toBe('json');
  });

  it('parses JSON from markdown/conversational wrapper text', async () => {
    mockPost.mockResolvedValue({
      data: {
        response:
          'Sure, here is the result:\n```json\n{"reasoning":"Corner Store is a grocery merchant.","categoryName":"Groceries","categoryId":1,"confidence":0.8}\n```\nAnything else?',
      },
    });

    const res = await suggestCategory(
      { id: 'exp-2b', title: 'Corner Store', amount: 5000, notes: '', currency: 'EUR' },
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
      { id: 'exp-2d', title: 'Highway fuel', amount: 3300, notes: '', currency: 'EUR' },
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
      { id: 'exp-2e', title: 'Fresh Market', amount: 1800, notes: '', currency: 'EUR' },
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
      { id: 'exp-4', title: 'Wardrobe', amount: 8000, notes: '', currency: 'EUR' },
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
      { id: 'exp-5', title: 'Wardrobe', amount: 8000, notes: '', currency: 'EUR' },
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
      { id: 'exp-6', title: 'Furniture Store', amount: 12000, notes: '', currency: 'EUR' },
      categories
    );

    expect(res.categoryId).toBe(7);
    expect(res.categoryName).toBe('Furniture');
    expect(res.confidence).toBe(0.72);
  });

  it('matches Lidl directly via word list without LLM call', async () => {
    const categories = [
      { id: 2, grouping: 'Entertainment', name: 'Entertainment' },
      { id: 11, grouping: 'Food & Drink', name: 'Groceries' },
    ];

    // With word list matching, LLM should not be called
    const res = await suggestCategory(
      { id: 'exp-7', title: 'Corner Store', amount: 2332, notes: '', currency: 'EUR' },
      categories
    );

    expect(res.categoryId).toBe(11);
    expect(res.categoryName).toBe('Groceries');
    expect(res.confidence).toBe(0.95); // Word list match confidence
    expect(res.source).toBe('wordlist');
    expect(mockPost).not.toHaveBeenCalled(); // LLM not called
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
    const guarded = applyTitleSemanticGuard({ title: 'Wardrobe' }, suggestion, categories);
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
    const out = applyFurnitureTitleOverride({ title: 'Wardrobe' }, suggestion, categories);
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
      reasoning: 'Corner Store is a grocery store',
    };
    const categories = [
      { id: 2, grouping: 'Entertainment', name: 'Entertainment' },
      { id: 11, grouping: 'Food & Drink', name: 'Groceries' },
    ];
    const out = applyGroceryMerchantOverride({ title: 'Corner Store' }, suggestion, categories);
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
