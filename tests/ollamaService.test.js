'use strict';

const { buildPrompt } = require('../src/services/ollamaService');

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
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"reasoning"');
  });

  it('handles missing currency gracefully', () => {
    const prompt = buildPrompt({ ...baseExpense, currency: undefined }, CATEGORIES);
    expect(prompt).toContain('42.50');
    // Should still include the amount even without a currency symbol
    expect(typeof prompt).toBe('string');
  });
});
