'use strict';

const axios = require('axios');
const config = require('../config');

const client = axios.create({
  baseURL: config.ollama.baseUrl,
  timeout: config.ollama.timeoutMs,
});

/**
 * Check that the Ollama service is reachable and the configured model is available.
 * @returns {{ ok: boolean, models: string[] }}
 */
async function healthCheck() {
  try {
    const res = await client.get('/api/tags');
    const models = (res.data.models || []).map((m) => m.name);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, models: [], error: err.message };
  }
}

/**
 * Build a prompt that asks the LLM to categorize an expense.
 * @param {{ title: string, amount: number, notes?: string, currency?: string }} expense
 * @param {Array<{ id: number, grouping: string, name: string }>} categories
 * @returns {string}
 */
function buildPrompt(expense, categories) {
  const categoryList = categories
    .map((c) => `  - id ${c.id}: [${c.grouping}] ${c.name}`)
    .join('\n');

  const amountFormatted = expense.currency
    ? `${(expense.amount / 100).toFixed(2)} ${expense.currency}`
    : `${(expense.amount / 100).toFixed(2)}`;

  const notesPart =
    expense.notes && expense.notes.trim()
      ? `\nNotes: ${expense.notes.trim()}`
      : '';

  return `You are an expense categorization assistant. Given an expense and a list of categories, select the most appropriate category.

Expense:
  Title: ${expense.title}
  Amount: ${amountFormatted}${notesPart}

Available categories:
${categoryList}

Respond ONLY with valid JSON in this exact format:
{
  "categoryId": <integer id from the list above>,
  "confidence": <float between 0 and 1>,
  "reasoning": "<short explanation>"
}`;
}

/**
 * Strip markdown code fences that some models wrap around JSON output.
 * @param {string} text
 * @returns {string}
 */
function stripMarkdown(text) {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

/**
 * Ask Ollama to suggest a category for the given expense.
 * @param {{ id: string, title: string, amount: number, notes?: string, currency?: string }} expense
 * @param {Array<{ id: number, grouping: string, name: string }>} categories
 * @returns {{ categoryId: number, confidence: number, reasoning: string }}
 */
async function suggestCategory(expense, categories) {
  const prompt = buildPrompt(expense, categories);

  const payload = {
    model: config.ollama.model,
    prompt,
    stream: false,
    format: 'json',
  };

  let response;
  try {
    response = await client.post('/api/generate', payload);
  } catch (err) {
    throw new Error(`Ollama request failed: ${err.message}`);
  }

  const raw = (response.data && response.data.response) || '';
  const cleaned = stripMarkdown(raw);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse Ollama response as JSON: ${cleaned.substring(0, 200)}`);
  }

  const categoryId = parseInt(parsed.categoryId, 10);
  const confidence = parseFloat(parsed.confidence);

  if (!Number.isFinite(categoryId) || categoryId <= 0) {
    throw new Error(`Invalid categoryId in Ollama response: ${parsed.categoryId}`);
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`Invalid confidence in Ollama response: ${parsed.confidence}`);
  }

  const validIds = new Set(categories.map((c) => c.id));
  if (!validIds.has(categoryId)) {
    throw new Error(
      `Ollama returned categoryId ${categoryId} which is not in the list of valid categories`
    );
  }

  return {
    categoryId,
    confidence,
    reasoning: parsed.reasoning || '',
  };
}

module.exports = { healthCheck, suggestCategory, buildPrompt, stripMarkdown };
