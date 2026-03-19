'use strict';

const axios = require('axios');
const config = require('../config');

const client = axios.create({
  baseURL: config.ollama.baseUrl,
  timeout: config.ollama.timeoutMs,
});

const OLLAMA_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['categoryId', 'categoryName', 'confidence', 'reasoning'],
  properties: {
    categoryId: { type: 'integer' },
    categoryName: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasoning: { type: 'string' },
  },
};

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
    .map((c) => `- [ID: ${c.id}] ${c.name} (Group: ${c.grouping})`)
    .join('\n');

  const amountFormatted = expense.currency
    ? `${(expense.amount / 100).toFixed(2)} ${expense.currency}`
    : `${(expense.amount / 100).toFixed(2)}`;

  const notesPart =
    expense.notes && expense.notes.trim()
      ? `\nNotes: ${expense.notes.trim()}`
      : '';

  return `You are an expense categorization assistant for Spliit.
You must always return valid JSON only.

Rules:
1) Choose exactly one category from the provided list.
2) categoryName must exactly match one list entry name. categoryId must be the exact ID of that same entry.
3) Expense titles and notes are often in German (for example: Edeka, Tankstelle). Interpret German context correctly before mapping to a category.
4) If uncertain, pick the best matching category and lower confidence.
5) JSON key order is mandatory: output "reasoning" first, then "categoryName", then "categoryId", then "confidence".

Few-shot examples (follow this mapping behavior exactly):
Example 1:
Input expense title: "Edeka"
Correct output:
{
  "reasoning": "Edeka is a German supermarket merchant, so this is a grocery expense.",
  "categoryName": "Groceries",
  "categoryId": 1,
  "confidence": 0.91
}

Example 2:
Input expense title: "Tankstelle"
Correct output:
{
  "reasoning": "Tankstelle means gas station in German, so this maps to fuel expenses.",
  "categoryName": "Fuel",
  "categoryId": 3,
  "confidence": 0.93
}

Expense:
  Title: ${expense.title}
  Amount: ${amountFormatted}${notesPart}

Available categories:
${categoryList}

Respond ONLY with valid JSON in this exact format:
{
  "reasoning": "<short explanation>",
  "categoryName": "<exact category name from the list above>",
  "categoryId": <integer id from the list above that exactly matches categoryName>,
  "confidence": <float between 0 and 1>
}
No markdown, no extra keys.`;
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
 * @returns {{ categoryId: number, categoryName: string, confidence: number, reasoning: string }}
 */
async function suggestCategory(expense, categories) {
  const prompt = buildPrompt(expense, categories);

  const payload = {
    model: config.ollama.model,
    prompt,
    stream: false,
    format: OLLAMA_RESPONSE_SCHEMA,
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

  const parsedKeys = Object.keys(parsed).sort();
  const expectedKeys = ['categoryId', 'categoryName', 'confidence', 'reasoning'];
  if (
    parsedKeys.length !== expectedKeys.length ||
    expectedKeys.some((key, idx) => key !== parsedKeys[idx])
  ) {
    throw new Error(
      `Invalid response shape from Ollama. Expected keys: ${expectedKeys.join(', ')}`
    );
  }

  const categoryId = parseInt(parsed.categoryId, 10);
  const categoryName =
    typeof parsed.categoryName === 'string' ? parsed.categoryName.trim() : '';
  const confidence = parseFloat(parsed.confidence);
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

  if (!Number.isFinite(categoryId) || categoryId <= 0) {
    throw new Error(`Invalid categoryId in Ollama response: ${parsed.categoryId}`);
  }
  if (!categoryName) {
    throw new Error(`Invalid categoryName in Ollama response: ${parsed.categoryName}`);
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`Invalid confidence in Ollama response: ${parsed.confidence}`);
  }
  if (typeof parsed.reasoning !== 'string') {
    throw new Error(`Invalid reasoning in Ollama response: ${parsed.reasoning}`);
  }

  const categoryEntry = categories.find((c) => c.id === categoryId);
  if (!categoryEntry) {
    throw new Error(
      `Ollama returned categoryId ${categoryId} which is not in the list of valid categories`
    );
  }
  if (categoryName !== categoryEntry.name) {
    throw new Error(
      `Ollama returned mismatched categoryId/categoryName: ${categoryId} -> "${categoryEntry.name}", got "${categoryName}"`
    );
  }

  return {
    categoryId,
    categoryName,
    confidence,
    reasoning,
  };
}

module.exports = { healthCheck, suggestCategory, buildPrompt, stripMarkdown };
