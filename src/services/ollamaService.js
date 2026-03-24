'use strict';

const axios = require('axios');
const config = require('../config');
const historyService = require('./historyService');

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
const MAX_FURNITURE_NON_HOME_CONFIDENCE = 0.39;
const GROCERY_MERCHANT_KEYWORDS = ['lidl', 'rewe', 'edeka', 'aldi', 'kaufland'];
const FURNITURE_TITLE_KEYWORDS = [
  'schrank',
  'tisch',
  'stuhl',
  'sofa',
  'bett',
  'kommode',
  'regal',
  'schreibtisch',
  'lampe',
  'möbel',
  'moebel',
];

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
  const customTemplate = historyService.getCategorizationPromptTemplate();
  const categoryList = categories
    .map((c) => `- [ID: ${c.id}] ${c.name} (Group: ${c.grouping})`)
    .join('\n');
  const allowedNames = categories.length
    ? categories.map((c) => `"${c.name}"`).join(', ')
    : '(none)';
  const foodLikeNames = categories
    .filter((c) => /food|drink|restaurant|dining|grocer|supermarket/i.test(`${c.grouping} ${c.name}`))
    .map((c) => `"${c.name}"`)
    .join(', ');

  const groceriesExampleCategory =
    categories.find((c) => /grocer|supermarket|lebensmittel/i.test(c.name)) ||
    categories[0];
  const fuelKeywordCategory = categories.find((c) =>
    /fuel|gas|petrol|tank/i.test(c.name)
  );
  const alternateExampleCategory =
    groceriesExampleCategory && categories.length > 1
      ? categories.find((c) => c.id !== groceriesExampleCategory.id)
      : undefined;
  let fuelExampleCategory = fuelKeywordCategory;
  if (fuelExampleCategory && groceriesExampleCategory) {
    fuelExampleCategory =
      fuelExampleCategory.id === groceriesExampleCategory.id
        ? alternateExampleCategory
        : fuelExampleCategory;
  } else if (!fuelExampleCategory) {
    fuelExampleCategory = alternateExampleCategory || groceriesExampleCategory;
  }
  const exampleSection =
    groceriesExampleCategory &&
    fuelExampleCategory &&
    groceriesExampleCategory.id !== fuelExampleCategory.id
      ? `Few-shot examples (follow this mapping behavior exactly):
Example 1:
Input expense title: "Edeka"
Correct output:
{
  "reasoning": "Edeka is a German supermarket merchant, so this is a grocery expense.",
  "categoryName": "${groceriesExampleCategory.name}",
  "categoryId": ${groceriesExampleCategory.id},
  "confidence": 0.91
}

Example 2:
Input expense title: "Tankstelle"
Correct output:
{
  "reasoning": "Tankstelle means gas station in German, so this maps to fuel expenses.",
  "categoryName": "${fuelExampleCategory.name}",
  "categoryId": ${fuelExampleCategory.id},
  "confidence": 0.93
}`
      : '';

  const amountFormatted = expense.currency
    ? `${(expense.amount / 100).toFixed(2)} ${expense.currency}`
    : `${(expense.amount / 100).toFixed(2)}`;

  const notesPart =
    expense.notes && expense.notes.trim()
      ? `\nNotes: ${expense.notes.trim()}`
      : '';
  if (typeof customTemplate === 'string' && customTemplate.trim()) {
    return customTemplate
      .replace(/\{\{ALLOWED_NAMES\}\}/g, allowedNames)
      .replace(/\{\{EXAMPLE_SECTION\}\}/g, exampleSection)
      .replace(/\{\{TITLE\}\}/g, expense.title)
      .replace(/\{\{AMOUNT\}\}/g, amountFormatted)
      .replace(/\{\{NOTES_PART\}\}/g, notesPart)
      .replace(/\{\{CATEGORY_LIST\}\}/g, categoryList)
      .replace(/\{\{FOOD_LIKE_NAMES\}\}/g, foodLikeNames ? ` (${foodLikeNames})` : '');
  }

  return `You are an expense categorization assistant for Spliit.
You must always return valid JSON only.

Rules:
1) Choose exactly one category from the provided list.
2) categoryName must exactly match one list entry name. categoryId must be the exact ID of that same entry.
3) Expense titles and notes are often in German (for example: Lidl, Rewe, Edeka, Aldi, Kaufland, Tankstelle). Interpret German context correctly before mapping to a category.
4) If uncertain, pick the best matching category and lower confidence.
5) JSON key order is mandatory: output "reasoning" first, then "categoryName", then "categoryId", then "confidence".
6) Never invent or alter category names. categoryName MUST be one of: ${allowedNames}.
7) Reasoning must describe the spending type first (e.g., groceries, fuel, furniture), then map that type to the closest category from the list.
8) Do not map by superficial word overlap. First infer what was purchased or the merchant type, then choose the closest category from the list.
9) For household/furniture item titles (e.g., Schrank, Tisch, Stuhl), avoid food-related categories unless the merchant clearly indicates food service or groceries${foodLikeNames ? ` (${foodLikeNames})` : ''}.

${exampleSection}

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
    .replace(/```(?:json)?/gi, '')
    .trim();
}

/**
 * Remove common reasoning/thinking wrapper tags emitted by some models.
 * @param {string} text
 * @returns {string}
 */
function stripThinkingTags(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Extract the first complete top-level JSON object from noisy model output.
 * Handles conversational filler around JSON and ignores braces inside strings.
 * @param {string} text
 * @returns {string}
 */
function extractFirstJsonObject(text) {
  const cleaned = stripThinkingTags(stripMarkdown(text || ''));
  const firstBraceIndex = cleaned.search(/\{/);
  if (firstBraceIndex < 0) return cleaned;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = firstBraceIndex; i < cleaned.length; i += 1) {
    const ch = cleaned[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return cleaned.slice(firstBraceIndex, i + 1).trim();
      }
    }
  }

  return cleaned.slice(firstBraceIndex).trim();
}

/**
 * Normalize potential response locations/shapes from Ollama into a string.
 * @param {any} data
 * @returns {string}
 */
function getRawModelText(data) {
  if (!data) return '';
  const candidate =
    data.response !== undefined
      ? data.response
      : data.message && data.message.content !== undefined
        ? data.message.content
        : '';
  if (typeof candidate === 'string') return candidate;
  try {
    return JSON.stringify(candidate);
  } catch {
    return String(candidate || '');
  }
}

/**
 * Check whether a normalized title contains a keyword as a standalone token.
 * @param {string} normalizedTitle
 * @param {string} keyword
 * @returns {boolean}
 */
function hasTitleKeyword(normalizedTitle, keyword) {
  return (
    normalizedTitle === keyword ||
    normalizedTitle.startsWith(`${keyword} `) ||
    normalizedTitle.endsWith(` ${keyword}`) ||
    normalizedTitle.includes(` ${keyword} `)
  );
}

/**
 * Check whether a category appears grocery/supermarket related.
 * @param {{ grouping?: string, name?: string }} category
 * @returns {boolean}
 */
function isGroceryLikeCategory(category) {
  const text = `${category && category.grouping ? category.grouping : ''} ${
    category && category.name ? category.name : ''
  }`.toLowerCase();
  const isGroceryLike = /grocer|grocery|supermarket|lebensmittel/.test(text);
  const isRestaurantLike = /restaurant|dining|cafe|bar|take.?away|delivery/.test(text);
  return isGroceryLike && !isRestaurantLike;
}

/**
 * For clear grocery merchants (e.g., Lidl/Rewe/Edeka), prefer a grocery/supermarket
 * category when available.
 * @param {{ title?: string }} expense
 * @param {{ categoryId: number, categoryName: string, confidence: number, reasoning: string }} suggestion
 * @param {Array<{ id: number, grouping: string, name: string }>} categories
 * @returns {{ categoryId: number, categoryName: string, confidence: number, reasoning: string }}
 */
function applyGroceryMerchantOverride(expense, suggestion, categories) {
  const normalizedTitle = String(expense && expense.title ? expense.title : '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalizedTitle) return suggestion;

  const isGroceryMerchantSignal = GROCERY_MERCHANT_KEYWORDS.some((keyword) =>
    hasTitleKeyword(normalizedTitle, keyword)
  );
  if (!isGroceryMerchantSignal) return suggestion;

  const selectedCategory = categories.find((c) => c.id === suggestion.categoryId);
  if (selectedCategory && isGroceryLikeCategory(selectedCategory)) return suggestion;

  const groceryCategory = categories.find((c) =>
    /grocer|grocery|supermarket|lebensmittel/.test(`${c.grouping} ${c.name}`.toLowerCase())
  );
  const fallbackGroceryCategory = categories.find((c) => isGroceryLikeCategory(c));
  const preferredCategory = groceryCategory || fallbackGroceryCategory;
  if (!preferredCategory) return suggestion;

  return {
    ...suggestion,
    categoryId: preferredCategory.id,
    categoryName: preferredCategory.name,
    reasoning: `${suggestion.reasoning} Heuristic note: "${expense.title}" is a known grocery merchant, so the suggestion was mapped to "${preferredCategory.name}".`,
  };
}

/**
 * Check whether a category appears furniture/home related.
 * @param {{ grouping?: string, name?: string }} category
 * @returns {boolean}
 */
function isFurnitureLikeCategory(category) {
  const text = `${category && category.grouping ? category.grouping : ''} ${
    category && category.name ? category.name : ''
  }`.toLowerCase();
  return /möbel|moebel|furniture|home|household|living|interior|wohnung|wohnen/.test(text);
}

/**
 * For clearly furniture-related titles/merchants (e.g., Schrank, IKEA), prefer
 * a furniture/home category when available.
 * @param {{ title?: string }} expense
 * @param {{ categoryId: number, categoryName: string, confidence: number, reasoning: string }} suggestion
 * @param {Array<{ id: number, grouping: string, name: string }>} categories
 * @returns {{ categoryId: number, categoryName: string, confidence: number, reasoning: string }}
 */
function applyFurnitureTitleOverride(expense, suggestion, categories) {
  const normalizedTitle = String(expense && expense.title ? expense.title : '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalizedTitle) return suggestion;

  const isFurnitureSignal =
    hasTitleKeyword(normalizedTitle, 'ikea') || hasTitleKeyword(normalizedTitle, 'schrank');
  if (!isFurnitureSignal) return suggestion;

  const selectedCategory = categories.find((c) => c.id === suggestion.categoryId);
  if (selectedCategory && isFurnitureLikeCategory(selectedCategory)) return suggestion;

  const primaryFurnitureCategory = categories.find((c) =>
    /möbel|moebel|furniture/.test(`${c.grouping} ${c.name}`.toLowerCase())
  );
  const fallbackFurnitureCategory = categories.find((c) => isFurnitureLikeCategory(c));
  const furnitureCategory = primaryFurnitureCategory || fallbackFurnitureCategory;
  if (!furnitureCategory) return suggestion;

  return {
    ...suggestion,
    categoryId: furnitureCategory.id,
    categoryName: furnitureCategory.name,
    confidence: suggestion.confidence,
    reasoning: `${suggestion.reasoning} Heuristic note: "${expense.title}" is furniture/home related, so the suggestion was mapped to "${furnitureCategory.name}".`,
  };
}

/**
 * Apply a conservative confidence guard for known ambiguous furniture-like titles
 * to avoid overconfident non-home classifications.
 * @param {{ title?: string }} expense
 * @param {{ categoryId: number, categoryName: string, confidence: number, reasoning: string }} suggestion
 * @param {Array<{ id: number, grouping: string, name: string }>} categories
 * @returns {{ categoryId: number, categoryName: string, confidence: number, reasoning: string }}
 */
function applyTitleSemanticGuard(expense, suggestion, categories) {
  const normalizedTitle = String(expense && expense.title ? expense.title : '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalizedTitle) return suggestion;

  const isFurnitureLikeTitle = FURNITURE_TITLE_KEYWORDS.some((keyword) =>
    hasTitleKeyword(normalizedTitle, keyword)
  );

  if (!isFurnitureLikeTitle) return suggestion;

  const selectedCategory = categories.find((c) => c.id === suggestion.categoryId);
  const isHomeLikeCategory =
    isFurnitureLikeCategory(selectedCategory || { grouping: '', name: suggestion.categoryName }) ||
    /renovat|diy|hardware|bau|garden/.test(
      `${selectedCategory ? selectedCategory.grouping : ''} ${
        selectedCategory ? selectedCategory.name : suggestion.categoryName
      }`.toLowerCase()
    );
  if (isHomeLikeCategory) return suggestion;

  const guardedConfidence = Math.min(
    suggestion.confidence,
    MAX_FURNITURE_NON_HOME_CONFIDENCE
  );
  if (guardedConfidence === suggestion.confidence) return suggestion;

  return {
    ...suggestion,
    confidence: guardedConfidence,
    reasoning: `${suggestion.reasoning} Heuristic note: "${expense.title}" is typically a furniture/household item, so non-home categories were down-ranked.`,
  };
}

function getNormalizedTitle(expense) {
  return String(expense && expense.title ? expense.title : '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tryDeterministicCategoryRules(expense, categories) {
  const normalizedTitle = getNormalizedTitle(expense);
  if (!normalizedTitle) return null;

  const rules = historyService.getDeterministicCategoryRules();
  if (!Array.isArray(rules) || rules.length === 0) return null;

  for (const rule of rules) {
    const keyword = String(rule && rule.keyword ? rule.keyword : '').toLowerCase().trim();
    const categoryPattern = String(rule && rule.categoryPattern ? rule.categoryPattern : '')
      .toLowerCase()
      .trim();
    if (!keyword || !categoryPattern) continue;
    if (!hasTitleKeyword(normalizedTitle, keyword)) continue;

    let regex;
    try {
      regex = new RegExp(categoryPattern, 'i');
    } catch {
      continue;
    }
    const matchedCategory = categories.find((c) => regex.test(`${c.grouping} ${c.name}`));
    if (!matchedCategory) continue;
    return {
      categoryId: matchedCategory.id,
      categoryName: matchedCategory.name,
      confidence: 0.99,
      reasoning:
        rule.reasoning ||
        `Deterministic rule matched merchant keyword "${keyword}" to category "${matchedCategory.name}".`,
    };
  }
  return null;
}

/**
 * Ask Ollama to suggest a category for the given expense.
 * @param {{ id: string, title: string, amount: number, notes?: string, currency?: string }} expense
 * @param {Array<{ id: number, grouping: string, name: string }>} categories
 * @returns {{ categoryId: number, categoryName: string, confidence: number, reasoning: string }}
 */
async function suggestCategory(expense, categories) {
  const deterministicSuggestion = tryDeterministicCategoryRules(expense, categories);
  if (deterministicSuggestion) {
    return deterministicSuggestion;
  }

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

  const raw = getRawModelText(response.data);
  const normalizedRaw = stripThinkingTags(stripMarkdown(raw || ''));
  const cleaned = extractFirstJsonObject(normalizedRaw);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    try {
      parsed = JSON.parse(normalizedRaw);
    } catch {
      throw new Error(`Failed to parse Ollama response as JSON: ${cleaned.substring(0, 200)}`);
    }
  }
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error(`Failed to parse nested Ollama JSON response: ${parsed.substring(0, 200)}`);
    }
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

  if (!categoryName) {
    throw new Error(`Invalid categoryName in Ollama response: ${parsed.categoryName}`);
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`Invalid confidence in Ollama response: ${parsed.confidence}`);
  }
  if (typeof parsed.reasoning !== 'string') {
    throw new Error(`Invalid reasoning in Ollama response: ${parsed.reasoning}`);
  }

  const categoryEntryByName = categories.find((c) => c.name === categoryName);
  const categoryEntryById = categories.find((c) => c.id === categoryId);
  const resolvedCategory = categoryEntryByName || categoryEntryById;
  if (!resolvedCategory) {
    throw new Error(
      `Ollama returned invalid category reference: id=${parsed.categoryId}, name="${categoryName}"`
    );
  }

  const baseSuggestion = {
    categoryId: resolvedCategory.id,
    categoryName: resolvedCategory.name,
    confidence,
    reasoning,
  };
  const groceryAdjusted = applyGroceryMerchantOverride(expense, baseSuggestion, categories);
  const furnitureAdjusted = applyFurnitureTitleOverride(expense, groceryAdjusted, categories);
  return applyTitleSemanticGuard(expense, furnitureAdjusted, categories);
}

module.exports = {
  healthCheck,
  suggestCategory,
  buildPrompt,
  stripMarkdown,
  stripThinkingTags,
  extractFirstJsonObject,
  getRawModelText,
  isGroceryLikeCategory,
  applyGroceryMerchantOverride,
  isFurnitureLikeCategory,
  applyFurnitureTitleOverride,
  applyTitleSemanticGuard,
  tryDeterministicCategoryRules,
};
