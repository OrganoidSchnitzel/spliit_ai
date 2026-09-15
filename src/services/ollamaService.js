'use strict';

const axios = require('axios');
const config = require('../config');
const settingsStore = require('../settingsStore');
const germanWordLists = require('../data/germanWordLists');

/**
 * Response contract. Passed to Ollama as `format` so decoding is constrained
 * to this shape rather than to generic JSON — the model cannot emit prose,
 * markdown fences or a missing field in the first place.
 */
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

const REQUIRED_KEYS = ['categoryId', 'categoryName', 'confidence', 'reasoning'];
const MAX_FURNITURE_NON_HOME_CONFIDENCE = 0.39;

/** Errors worth retrying: the server was not reachable or was busy. */
const RETRYABLE_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN'];

let client = null;
let clientKey = null;

/**
 * Axios client, rebuilt when the base URL or timeout changes at runtime.
 */
function getClient() {
  const baseURL = settingsStore.get('ollama.baseUrl');
  const timeout = settingsStore.get('ollama.timeoutMs');
  const key = `${baseURL}|${timeout}`;
  if (!client || clientKey !== key) {
    client = axios.create({ baseURL, timeout });
    clientKey = key;
  }
  return client;
}

// Invalidate the cached client whenever connection settings change.
settingsStore.onChange((changed) => {
  if (changed.some((k) => k === 'ollama.baseUrl' || k === 'ollama.timeoutMs')) {
    client = null;
  }
});

/**
 * Check that Ollama is reachable and report which models it has.
 * @returns {Promise<{ ok: boolean, models: string[], modelAvailable?: boolean }>}
 */
async function healthCheck() {
  try {
    const res = await getClient().get('/api/tags');
    const models = (res.data.models || []).map((m) => m.name);
    const configured = settingsStore.get('ollama.model');
    return {
      ok: true,
      models,
      model: configured,
      // A configured model that is not pulled is the single most common
      // cause of "every expense errors", and it was invisible before.
      modelAvailable: models.some((m) => m === configured || m.split(':')[0] === configured.split(':')[0]),
    };
  } catch (err) {
    return { ok: false, models: [], error: err.message };
  }
}

/**
 * Build the prompt that asks the model to categorize an expense.
 * @param {{ title: string, amount: number, notes?: string, currency?: string }} expense
 * @param {Array<{ id: number, grouping: string, name: string }>} categories
 * @returns {string}
 */
function buildPrompt(expense, categories) {
  const template = settingsStore.get('ollama.customPromptTemplate');
  if (template) return buildCustomPrompt(expense, categories, template);

  const categoryList = categories.map((c) => `${c.id}:${c.name}`).join('|');
  const amountFormatted = formatAmount(expense);
  const notesPart =
    expense.notes && expense.notes.trim() ? ` Notes:${expense.notes.trim()}` : '';

  return `Categorize expense. Return JSON only.
Title:${expense.title}
Amount:${amountFormatted}${notesPart}
Categories(id:name): ${categoryList}

Rules:
- Pick ONE category ID from list
- German context examples:
  * Lidl/Rewe/Edeka/Aldi→Groceries
  * Tankstelle/Shell/Aral→Gas/Fuel
  * IKEA/Möbel→Furniture
  * Apotheke/Arzt→Medical Expenses
  * Deutsche Bahn/Bus→Bus/Train
- Match by merchant type, not just word similarity
- Output format:
{"reasoning":"<why>","categoryName":"<exact name>","categoryId":<id>,"confidence":<0-1>}`;
}

function formatAmount(expense) {
  const value = (Number(expense.amount || 0) / 100).toFixed(2);
  return expense.currency ? `${value}${expense.currency}` : value;
}

/**
 * Placeholders a custom template may use.
 */
const TEMPLATE_PLACEHOLDERS = ['title', 'amount', 'notes', 'categories', 'categoryList'];

/** Placeholders a template must contain to be usable at all. */
const REQUIRED_PLACEHOLDERS = ['title', 'categories'];

/**
 * Validate a custom prompt template. A template missing its placeholders used
 * to be accepted and then silently broke every subsequent categorization.
 * @param {string} template
 * @returns {{ ok: true } }
 */
function validatePromptTemplate(template) {
  if (typeof template !== 'string' || !template.trim()) {
    throw Object.assign(new Error('Template cannot be empty'), { statusCode: 400 });
  }

  const missing = REQUIRED_PLACEHOLDERS.filter(
    (name) => !new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(template)
  );
  if (missing.length) {
    throw Object.assign(
      new Error(
        `Template is missing required placeholder(s): ${missing
          .map((m) => `{{${m}}}`)
          .join(', ')}`
      ),
      { statusCode: 400 }
    );
  }

  const unknown = [...template.matchAll(/\{\{\s*(\w+)\s*\}\}/g)]
    .map((m) => m[1])
    .filter((name) => !TEMPLATE_PLACEHOLDERS.includes(name));
  if (unknown.length) {
    throw Object.assign(
      new Error(
        `Template uses unknown placeholder(s): ${[...new Set(unknown)]
          .map((m) => `{{${m}}}`)
          .join(', ')}. Available: ${TEMPLATE_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}`
      ),
      { statusCode: 400 }
    );
  }

  return { ok: true };
}

/**
 * Render a custom template.
 * Placeholders: {{title}}, {{amount}}, {{notes}}, {{categories}}, {{categoryList}}
 */
function buildCustomPrompt(expense, categories, template) {
  const categoryList = categories.map((c) => `${c.id}:${c.name}`).join('|');
  const categoryListDetailed = categories
    .map((c) => `[${c.id}] ${c.name} (${c.grouping})`)
    .join('\n');

  return template
    .replace(/\{\{\s*title\s*\}\}/g, expense.title)
    .replace(/\{\{\s*amount\s*\}\}/g, formatAmount(expense))
    .replace(/\{\{\s*notes\s*\}\}/g, expense.notes || '')
    .replace(/\{\{\s*categories\s*\}\}/g, categoryList)
    .replace(/\{\{\s*categoryList\s*\}\}/g, categoryListDetailed);
}

/** The prompt used when no custom template is set. */
function getDefaultPromptTemplate() {
  return `Categorize expense. Return JSON only.
Title:{{title}}
Amount:{{amount}}
Notes:{{notes}}
Categories(id:name): {{categories}}

Rules:
- Pick ONE category ID from list
- German context: Lidl/Rewe/Edeka/Aldi/Kaufland→Groceries, Tankstelle→Gas/Fuel, IKEA/Möbel→Furniture
- Match by merchant type, not just word similarity
- Output format:
{"reasoning":"<why>","categoryName":"<exact name>","categoryId":<id>,"confidence":<0-1>}`;
}

// ─── Response parsing ──────────────────────────────────────────────────────────
// Structured output makes most of this unnecessary on the happy path, but it
// stays as a fallback for older Ollama builds and for models that ignore the
// schema.

/** Strip markdown code fences some models wrap around JSON output. */
function stripMarkdown(text) {
  return text.replace(/```(?:json)?/gi, '').trim();
}

/** Remove reasoning/thinking wrapper tags emitted by some models. */
function stripThinkingTags(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Extract the first complete top-level JSON object from noisy model output,
 * ignoring braces inside strings.
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
      if (depth === 0) return cleaned.slice(firstBraceIndex, i + 1).trim();
    }
  }

  return cleaned.slice(firstBraceIndex).trim();
}

/** Normalize the various shapes Ollama can return into a string. */
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

function parseModelPayload(raw) {
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

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Ollama response was not a JSON object');
  }

  // Require the expected keys; tolerate extras. An exact key-set match meant a
  // single stray field like "explanation" failed the whole expense.
  const missing = REQUIRED_KEYS.filter((key) => parsed[key] === undefined);
  if (missing.length) {
    throw new Error(
      `Invalid response shape from Ollama. Missing key(s): ${missing.join(', ')}`
    );
  }

  return parsed;
}

// ─── Heuristic guards ──────────────────────────────────────────────────────────

/** Check whether a normalized title contains a keyword as a standalone token. */
function hasTitleKeyword(normalizedTitle, keyword) {
  return (
    normalizedTitle === keyword ||
    normalizedTitle.startsWith(`${keyword} `) ||
    normalizedTitle.endsWith(` ${keyword}`) ||
    normalizedTitle.includes(` ${keyword} `)
  );
}

/** Check whether a category appears grocery/supermarket related. */
function isGroceryLikeCategory(category) {
  const text = `${category && category.grouping ? category.grouping : ''} ${
    category && category.name ? category.name : ''
  }`.toLowerCase();
  const isGroceryLike = /grocer|grocery|supermarket|lebensmittel/.test(text);
  const isRestaurantLike = /restaurant|dining|cafe|bar|take.?away|delivery/.test(text);
  return isGroceryLike && !isRestaurantLike;
}

/** Check whether a category appears furniture/home related. */
function isFurnitureLikeCategory(category) {
  const text = `${category && category.grouping ? category.grouping : ''} ${
    category && category.name ? category.name : ''
  }`.toLowerCase();
  return /möbel|moebel|furniture|home|household|living|interior|wohnung|wohnen/.test(text);
}

/**
 * Re-check the model's answer against the word lists.
 *
 * This replaces the three near-identical merchant-specific overrides that used
 * to live here (grocery, furniture, and a furniture confidence guard, ~180
 * lines). They each re-implemented substring matching against a private
 * keyword constant; the word lists already express the same knowledge as data
 * and now match it properly — at token boundaries, across German compounds and
 * umlaut spellings, with an explicit tie-break.
 *
 * Only applied when the word lists did not already answer (i.e. on the LLM
 * path), so it costs one extra match per LLM call.
 */
function applyWordListGuard(expense, suggestion, categories) {
  const wordListMatch = germanWordLists.matchWordList(expense, categories);
  if (!wordListMatch) return suggestion;
  if (wordListMatch.categoryId === suggestion.categoryId) return suggestion;

  return {
    ...suggestion,
    categoryId: wordListMatch.categoryId,
    categoryName: wordListMatch.categoryName,
    // The word list is deterministic but the model disagreed, so do not claim
    // more certainty than the weaker of the two.
    confidence: Math.min(suggestion.confidence, wordListMatch.confidence),
    reasoning:
      `${suggestion.reasoning} Heuristic note: the ${wordListMatch.listName} word list ` +
      `matched "${wordListMatch.keyword}", so the suggestion was mapped to ` +
      `"${wordListMatch.categoryName}".`,
    source: 'llm+wordlist',
  };
}

/**
 * Down-rank an overconfident non-home classification for a title that is
 * plainly a furniture or household item. Unlike the guard above this does not
 * remap — it only refuses to auto-apply — so it still helps when the Spliit
 * instance has no furniture category at all.
 */
function applyTitleSemanticGuard(expense, suggestion, categories) {
  const normalizedTitle = germanWordLists.normalizeText(expense && expense.title);
  if (!normalizedTitle) return suggestion;

  const furnitureKeywords = germanWordLists.getWordLists().furniture;
  const isFurnitureLikeTitle =
    !!furnitureKeywords &&
    furnitureKeywords.keywords.some((keyword) =>
      hasTitleKeyword(normalizedTitle, germanWordLists.normalizeKeyword(keyword))
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

  const guardedConfidence = Math.min(suggestion.confidence, MAX_FURNITURE_NON_HOME_CONFIDENCE);
  if (guardedConfidence === suggestion.confidence) return suggestion;

  return {
    ...suggestion,
    confidence: guardedConfidence,
    reasoning:
      `${suggestion.reasoning} Heuristic note: "${expense.title}" is typically a ` +
      'furniture/household item, so non-home categories were down-ranked.',
  };
}

// ─── Inference ─────────────────────────────────────────────────────────────────

function isRetryable(err) {
  if (err.response) return err.response.status >= 500;
  return RETRYABLE_CODES.includes(err.code) || /timeout/i.test(err.message || '');
}

const sleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // The HTTP server keeps the loop alive anyway; not holding it open here
    // lets short-lived processes (and the test runner) exit cleanly.
    if (typeof timer.unref === 'function') timer.unref();
  });

/**
 * POST to Ollama, retrying transient failures with backoff.
 */
async function generate(payload) {
  const maxRetries = settingsStore.get('ollama.maxRetries') ?? config.ollama.maxRetries;
  let lastErr;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await getClient().post('/api/generate', payload);
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !isRetryable(err)) break;
      const waitMs = 500 * 2 ** attempt;
      console.warn(
        `[Ollama] ${err.message} — retrying in ${waitMs}ms (attempt ${attempt + 2}/${maxRetries + 1})`
      );
      await sleep(waitMs);
    }
  }

  const detail =
    lastErr.response && lastErr.response.data && lastErr.response.data.error
      ? lastErr.response.data.error
      : lastErr.message;
  throw new Error(`Ollama request failed: ${detail}`);
}

/**
 * Suggest a category for an expense.
 *
 * Deterministic word lists are consulted first because they are effectively
 * free; the LLM is the fallback.
 *
 * @param {{ id?: string, title: string, amount: number, notes?: string, currency?: string }} expense
 * @param {Array<{ id: number, grouping: string, name: string }>} categories
 * @param {{ skipWordLists?: boolean }} [opts]
 */
async function suggestCategory(expense, categories, opts = {}) {
  const startedAt = Date.now();

  if (!opts.skipWordLists && settingsStore.get('wordListsEnabled')) {
    const wordListMatch = germanWordLists.matchWordList(expense, categories);
    if (wordListMatch) {
      return { ...wordListMatch, durationMs: Date.now() - startedAt };
    }
  }

  const prompt = buildPrompt(expense, categories);
  const payload = {
    model: settingsStore.get('ollama.model'),
    prompt,
    stream: false,
    // Constrain decoding to the response contract rather than to "some JSON".
    format: settingsStore.get('ollama.useStructuredOutput') ? OLLAMA_RESPONSE_SCHEMA : 'json',
    // Ollama's default keep_alive (5m) is shorter than the default scheduler
    // interval (15m), so the model was evicted and re-read from disk before
    // every batch — the dominant cost on a CPU-only box.
    keep_alive: settingsStore.get('ollama.keepAlive'),
    options: {
      temperature: settingsStore.get('ollama.temperature'),
      num_predict: settingsStore.get('ollama.numPredict'),
      num_ctx: settingsStore.get('ollama.numCtx'),
    },
  };

  const response = await generate(payload);
  const parsed = parseModelPayload(getRawModelText(response.data));

  const categoryId = parseInt(parsed.categoryId, 10);
  const categoryName =
    typeof parsed.categoryName === 'string' ? parsed.categoryName.trim() : '';
  const confidence = parseFloat(parsed.confidence);

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
    reasoning: parsed.reasoning,
    source: 'llm',
  };

  const guarded = applyTitleSemanticGuard(
    expense,
    applyWordListGuard(expense, baseSuggestion, categories),
    categories
  );

  return { ...guarded, durationMs: Date.now() - startedAt };
}

module.exports = {
  healthCheck,
  suggestCategory,
  buildPrompt,
  buildCustomPrompt,
  getDefaultPromptTemplate,
  validatePromptTemplate,
  stripMarkdown,
  stripThinkingTags,
  extractFirstJsonObject,
  getRawModelText,
  parseModelPayload,
  isGroceryLikeCategory,
  isFurnitureLikeCategory,
  applyWordListGuard,
  applyTitleSemanticGuard,
  hasTitleKeyword,
  OLLAMA_RESPONSE_SCHEMA,
  TEMPLATE_PLACEHOLDERS,
};
