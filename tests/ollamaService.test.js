'use strict';

const axios = require('axios');
jest.mock('axios');
const mockPost = jest.fn();
const mockGet = jest.fn();
axios.create.mockReturnValue({ post: mockPost, get: mockGet });

const ollamaService = require('../src/services/ollamaService');
const wordLists = require('../src/data/germanWordLists');
const settingsStore = require('../src/settingsStore');
const localDb = require('../src/localDb');

const {
  buildPrompt,
  suggestCategory,
  validatePromptTemplate,
  extractFirstJsonObject,
  stripThinkingTags,
  getRawModelText,
  parseModelPayload,
  isGroceryLikeCategory,
  applyWordListGuard,
  applyTitleSemanticGuard,
  OLLAMA_RESPONSE_SCHEMA,
} = ollamaService;

const CATEGORIES = [
  { id: 1, grouping: 'Food & Drink', name: 'Groceries' },
  { id: 2, grouping: 'Food & Drink', name: 'Restaurants' },
  { id: 3, grouping: 'Transport', name: 'Fuel' },
  { id: 4, grouping: 'Transport', name: 'Public Transit' },
  { id: 5, grouping: 'Entertainment', name: 'Movies' },
];

/** A title that no word list matches, so the LLM path is exercised. */
const NEUTRAL_TITLE = 'Zahlung an Quibblewick';

const respond = (payload) =>
  mockPost.mockResolvedValue({ data: { response: JSON.stringify(payload) } });

beforeAll(() => {
  localDb.init();
  settingsStore.init();
  wordLists.init();
});

afterEach(() => {
  settingsStore.resetAll();
});

describe('ollamaService.buildPrompt', () => {
  const baseExpense = { id: 'exp-1', title: 'Lidl groceries', amount: 4250, currency: 'EUR', notes: null };

  it('includes the expense title', () => {
    expect(buildPrompt(baseExpense, CATEGORIES)).toContain('Lidl groceries');
  });

  it('converts amount from cents to display value', () => {
    expect(buildPrompt(baseExpense, CATEGORIES)).toContain('42.50');
  });

  it('includes the currency', () => {
    expect(buildPrompt(baseExpense, CATEGORIES)).toContain('EUR');
  });

  it('lists all categories with their ids in compact format', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    CATEGORIES.forEach((c) => expect(prompt).toContain(`${c.id}:${c.name}`));
  });

  it('omits the notes section when notes are empty', () => {
    expect(buildPrompt(baseExpense, CATEGORIES)).not.toContain('Notes:');
  });

  it('includes notes when provided', () => {
    const prompt = buildPrompt({ ...baseExpense, notes: 'weekly shop' }, CATEGORIES);
    expect(prompt).toContain('Notes:weekly shop');
  });

  it('instructs the model to respond with JSON', () => {
    expect(buildPrompt(baseExpense, CATEGORIES)).toContain('JSON');
  });

  it('includes German merchant guidance', () => {
    const prompt = buildPrompt(baseExpense, CATEGORIES);
    expect(prompt).toContain('Lidl/Rewe/Edeka/Aldi→Groceries');
    expect(prompt).toContain('IKEA/Möbel→Furniture');
  });

  it('handles a missing currency gracefully', () => {
    const prompt = buildPrompt({ ...baseExpense, currency: undefined }, CATEGORIES);
    expect(prompt).toContain('42.50');
    expect(prompt).not.toContain('undefined');
  });

  it('uses a persisted custom template when one is set', () => {
    settingsStore.setMany({ 'ollama.customPromptTemplate': 'X {{title}} Y {{categories}}' });
    expect(buildPrompt(baseExpense, CATEGORIES)).toBe('X Lidl groceries Y 1:Groceries|2:Restaurants|3:Fuel|4:Public Transit|5:Movies');
  });
});

describe('ollamaService.validatePromptTemplate', () => {
  it('accepts a template with the required placeholders', () => {
    expect(validatePromptTemplate('{{title}} {{categories}}')).toEqual({ ok: true });
  });

  it('rejects a template missing required placeholders', () => {
    expect(() => validatePromptTemplate('no placeholders')).toThrow(/missing required placeholder/i);
  });

  it('rejects a template using an unknown placeholder', () => {
    expect(() => validatePromptTemplate('{{title}} {{categories}} {{bogus}}')).toThrow(/unknown placeholder/i);
  });

  it('rejects an empty template', () => {
    expect(() => validatePromptTemplate('   ')).toThrow(/cannot be empty/i);
  });
});

describe('ollamaService.suggestCategory — request shape', () => {
  it('sends the response schema, keep_alive and generation options', async () => {
    respond({ categoryId: 1, categoryName: 'Groceries', confidence: 0.9, reasoning: 'ok' });
    await suggestCategory({ title: NEUTRAL_TITLE, amount: 100 }, CATEGORIES);

    const [, payload] = mockPost.mock.calls[0];
    expect(payload.format).toEqual(OLLAMA_RESPONSE_SCHEMA);
    // Ollama's 5m default is shorter than the 15m scheduler interval, which
    // made it re-read the model from disk before every batch.
    expect(payload.keep_alive).toBe('30m');
    expect(payload.options).toMatchObject({ temperature: 0, num_predict: 256, num_ctx: 2048 });
    expect(payload.stream).toBe(false);
  });

  it('falls back to generic JSON mode when structured output is disabled', async () => {
    settingsStore.setMany({ 'ollama.useStructuredOutput': false });
    respond({ categoryId: 1, categoryName: 'Groceries', confidence: 0.9, reasoning: 'ok' });
    await suggestCategory({ title: NEUTRAL_TITLE, amount: 100 }, CATEGORIES);
    expect(mockPost.mock.calls[0][1].format).toBe('json');
  });

  it('retries a transient failure and then succeeds', async () => {
    const err = new Error('socket hang up');
    err.code = 'ECONNRESET';
    mockPost
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        data: { response: JSON.stringify({ categoryId: 1, categoryName: 'Groceries', confidence: 0.8, reasoning: 'r' }) },
      });

    const res = await suggestCategory({ title: NEUTRAL_TITLE, amount: 100 }, CATEGORIES);
    expect(res.categoryId).toBe(1);
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-transient failure', async () => {
    const err = new Error('bad request');
    err.response = { status: 400, data: { error: 'model not found' } };
    mockPost.mockRejectedValue(err);

    await expect(suggestCategory({ title: NEUTRAL_TITLE, amount: 100 }, CATEGORIES)).rejects.toThrow(
      /model not found/
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});

describe('ollamaService.suggestCategory — response handling', () => {
  it('returns a parsed suggestion', async () => {
    respond({ categoryId: 3, categoryName: 'Fuel', confidence: 0.82, reasoning: 'fuel stop' });
    const res = await suggestCategory({ title: NEUTRAL_TITLE, amount: 5000 }, CATEGORIES);
    expect(res).toMatchObject({ categoryId: 3, categoryName: 'Fuel', confidence: 0.82, source: 'llm' });
    expect(typeof res.durationMs).toBe('number');
  });

  it('parses JSON out of markdown and conversational wrapping', async () => {
    mockPost.mockResolvedValue({
      data: { response: 'Sure!\n```json\n{"categoryId":1,"categoryName":"Groceries","confidence":0.7,"reasoning":"r"}\n```' },
    });
    const res = await suggestCategory({ title: NEUTRAL_TITLE, amount: 1 }, CATEGORIES);
    expect(res.categoryId).toBe(1);
  });

  it('parses JSON when the model emits a <think> wrapper first', async () => {
    mockPost.mockResolvedValue({
      data: { response: '<think>hmm</think>{"categoryId":1,"categoryName":"Groceries","confidence":0.77,"reasoning":"r"}' },
    });
    const res = await suggestCategory({ title: NEUTRAL_TITLE, amount: 1 }, CATEGORIES);
    expect(res.confidence).toBe(0.77);
  });

  it('reads chat-style message.content responses', async () => {
    mockPost.mockResolvedValue({
      data: { message: { content: '{"categoryId":2,"categoryName":"Restaurants","confidence":0.6,"reasoning":"r"}' } },
    });
    expect((await suggestCategory({ title: NEUTRAL_TITLE, amount: 1 }, CATEGORIES)).categoryId).toBe(2);
  });

  it('tolerates extra keys instead of failing the whole expense', async () => {
    respond({
      categoryId: 1,
      categoryName: 'Groceries',
      confidence: 0.9,
      reasoning: 'r',
      explanation: 'an extra field some models add',
    });
    expect((await suggestCategory({ title: NEUTRAL_TITLE, amount: 1 }, CATEGORIES)).categoryId).toBe(1);
  });

  it('repairs a mismatched categoryId by trusting a valid categoryName', async () => {
    respond({ categoryId: 99, categoryName: 'Groceries', confidence: 0.9, reasoning: 'r' });
    expect((await suggestCategory({ title: NEUTRAL_TITLE, amount: 1 }, CATEGORIES)).categoryId).toBe(1);
  });

  it('repairs a mismatched categoryName by trusting a valid categoryId', async () => {
    respond({ categoryId: 2, categoryName: 'Not A Category', confidence: 0.9, reasoning: 'r' });
    expect((await suggestCategory({ title: NEUTRAL_TITLE, amount: 1 }, CATEGORIES)).categoryName).toBe('Restaurants');
  });

  it('rejects a response where neither id nor name is valid', async () => {
    respond({ categoryId: 99, categoryName: 'Nope', confidence: 0.9, reasoning: 'r' });
    await expect(suggestCategory({ title: NEUTRAL_TITLE, amount: 1 }, CATEGORIES)).rejects.toThrow(
      /invalid category reference/i
    );
  });

  it('rejects an out-of-range confidence', async () => {
    respond({ categoryId: 1, categoryName: 'Groceries', confidence: 7, reasoning: 'r' });
    await expect(suggestCategory({ title: NEUTRAL_TITLE, amount: 1 }, CATEGORIES)).rejects.toThrow(
      /invalid confidence/i
    );
  });
});

describe('ollamaService.suggestCategory — word lists', () => {
  it('answers from the word list without calling the LLM', async () => {
    const res = await suggestCategory({ title: 'Lidl Einkauf', amount: 4250 }, CATEGORIES);
    expect(res).toMatchObject({ categoryName: 'Groceries', source: 'wordlist' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('goes to the LLM when skipWordLists is set', async () => {
    respond({ categoryId: 5, categoryName: 'Movies', confidence: 0.9, reasoning: 'r' });
    const res = await suggestCategory({ title: 'Lidl Einkauf', amount: 1 }, CATEGORIES, {
      skipWordLists: true,
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
    // The post-LLM guard still pulls an obvious merchant back to the word list.
    expect(res.categoryName).toBe('Groceries');
    expect(res.source).toBe('llm+wordlist');
  });

  it('goes to the LLM when word lists are disabled entirely', async () => {
    settingsStore.setMany({ wordListsEnabled: false });
    respond({ categoryId: 2, categoryName: 'Restaurants', confidence: 0.9, reasoning: 'r' });
    await suggestCategory({ title: NEUTRAL_TITLE, amount: 1 }, CATEGORIES);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});

describe('ollamaService.applyWordListGuard', () => {
  const suggestion = { categoryId: 5, categoryName: 'Movies', confidence: 0.8, reasoning: 'model guess' };

  it('remaps a suggestion the word lists disagree with', () => {
    const out = applyWordListGuard({ title: 'Rewe Wocheneinkauf' }, suggestion, CATEGORIES);
    expect(out).toMatchObject({ categoryId: 1, categoryName: 'Groceries', source: 'llm+wordlist' });
    expect(out.reasoning).toContain('Heuristic note');
  });

  it('never claims more confidence than the weaker of the two sources', () => {
    const out = applyWordListGuard({ title: 'Rewe Wocheneinkauf' }, { ...suggestion, confidence: 0.99 }, CATEGORIES);
    expect(out.confidence).toBeLessThanOrEqual(0.99);
  });

  it('leaves the suggestion alone when the word lists agree', () => {
    const agreeing = { categoryId: 1, categoryName: 'Groceries', confidence: 0.8, reasoning: 'r' };
    expect(applyWordListGuard({ title: 'Rewe' }, agreeing, CATEGORIES)).toEqual(agreeing);
  });

  it('leaves the suggestion alone when no keyword matches', () => {
    expect(applyWordListGuard({ title: NEUTRAL_TITLE }, suggestion, CATEGORIES)).toEqual(suggestion);
  });
});

describe('ollamaService.applyTitleSemanticGuard', () => {
  const furnitureCategories = [
    { id: 5, grouping: 'Entertainment', name: 'Entertainment' },
    { id: 6, grouping: 'Transport', name: 'Fuel' },
  ];

  it('down-ranks an overconfident non-home category for a furniture title', () => {
    const out = applyTitleSemanticGuard(
      { title: 'Schrank' },
      { categoryId: 5, categoryName: 'Entertainment', confidence: 0.9, reasoning: 'r' },
      furnitureCategories
    );
    expect(out.confidence).toBe(0.39);
    expect(out.reasoning).toContain('Heuristic note');
  });

  it('keeps confidence when the category is already home-like', () => {
    const suggestion = { categoryId: 7, categoryName: 'Furniture', confidence: 0.9, reasoning: 'r' };
    const out = applyTitleSemanticGuard({ title: 'Schrank' }, suggestion, [
      { id: 7, grouping: 'Home', name: 'Furniture' },
    ]);
    expect(out).toEqual(suggestion);
  });

  it('ignores titles that are not furniture-like', () => {
    const suggestion = { categoryId: 5, categoryName: 'Entertainment', confidence: 0.9, reasoning: 'r' };
    expect(applyTitleSemanticGuard({ title: NEUTRAL_TITLE }, suggestion, furnitureCategories)).toEqual(suggestion);
  });
});

describe('ollamaService.parseModelPayload', () => {
  it('names the missing keys rather than failing opaquely', () => {
    expect(() => parseModelPayload('{"categoryId":1}')).toThrow(/Missing key\(s\): categoryName, confidence, reasoning/);
  });

  it('unwraps a doubly-encoded JSON string', () => {
    const inner = JSON.stringify({ categoryId: 1, categoryName: 'Groceries', confidence: 0.5, reasoning: 'r' });
    expect(parseModelPayload(JSON.stringify(inner)).categoryId).toBe(1);
  });
});

describe('ollamaService.extractFirstJsonObject', () => {
  it('extracts the first complete object from fenced conversational output', () => {
    const text = 'Here you go:\n```json\n{"a":1}\n```\nAnything else?';
    expect(extractFirstJsonObject(text)).toBe('{"a":1}');
  });

  it('ignores braces inside JSON string fields', () => {
    expect(extractFirstJsonObject('{"a":"}{"}')).toBe('{"a":"}{"}');
  });

  it('removes think tags first', () => {
    expect(extractFirstJsonObject('<think>{"x":1}</think>{"a":2}')).toBe('{"a":2}');
  });
});

describe('ollamaService.stripThinkingTags', () => {
  it('removes think blocks while leaving the rest intact', () => {
    expect(stripThinkingTags('<think>noise</think> keep me')).toBe('keep me');
  });
});

describe('ollamaService.getRawModelText', () => {
  it('prefers data.response', () => {
    expect(getRawModelText({ response: 'a', message: { content: 'b' } })).toBe('a');
  });

  it('falls back to chat-style message.content', () => {
    expect(getRawModelText({ message: { content: 'b' } })).toBe('b');
  });
});

describe('ollamaService.isGroceryLikeCategory', () => {
  it('matches grocery categories and excludes restaurants', () => {
    expect(isGroceryLikeCategory({ grouping: 'Food & Drink', name: 'Groceries' })).toBe(true);
    expect(isGroceryLikeCategory({ grouping: 'Food & Drink', name: 'Restaurants' })).toBe(false);
  });
});

describe('ollamaService.healthCheck', () => {
  it('flags a configured model that is not pulled', async () => {
    mockGet.mockResolvedValue({ data: { models: [{ name: 'qwen2.5:3b' }] } });
    settingsStore.setMany({ 'ollama.model': 'llama3.2' });
    const res = await ollamaService.healthCheck();
    expect(res).toMatchObject({ ok: true, modelAvailable: false });
  });

  it('reports a pulled model as available', async () => {
    mockGet.mockResolvedValue({ data: { models: [{ name: 'llama3.2:latest' }] } });
    settingsStore.setMany({ 'ollama.model': 'llama3.2' });
    expect((await ollamaService.healthCheck()).modelAvailable).toBe(true);
  });

  it('reports unreachable without throwing', async () => {
    mockGet.mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect(await ollamaService.healthCheck()).toMatchObject({ ok: false, models: [] });
  });
});
