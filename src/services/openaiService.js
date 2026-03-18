'use strict';

/**
 * OpenAI-compatible AI service.
 * Works with OpenAI, DeepSeek, LiteLLM, Fastchat, and any other provider
 * that implements the /v1/chat/completions endpoint.
 */

const axios = require('axios');
const config = require('../config');
const { buildPrompt, stripMarkdown } = require('./ollamaService');

const client = axios.create({
  baseURL: config.openai.baseUrl,
  timeout: config.openai.timeoutMs,
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.openai.apiKey}`,
  },
});

/**
 * Check that the OpenAI-compatible endpoint is reachable and returns a model list.
 * @returns {{ ok: boolean, models: string[] }}
 */
async function healthCheck() {
  try {
    const res = await client.get('/models');
    const models = (res.data.data || []).map((m) => m.id);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, models: [], error: err.message };
  }
}

/**
 * Ask an OpenAI-compatible model to suggest a category for the given expense.
 * @param {{ id: string, title: string, amount: number, notes?: string, currency?: string }} expense
 * @param {Array<{ id: number, grouping: string, name: string }>} categories
 * @returns {{ categoryId: number, confidence: number, reasoning: string }}
 */
async function suggestCategory(expense, categories) {
  const prompt = buildPrompt(expense, categories);

  const payload = {
    model: config.openai.model,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  };

  let response;
  try {
    response = await client.post('/chat/completions', payload);
  } catch (err) {
    const detail =
      err.response && err.response.data
        ? JSON.stringify(err.response.data).substring(0, 200)
        : err.message;
    throw new Error(`OpenAI request failed: ${detail}`);
  }

  const raw =
    response.data &&
    response.data.choices &&
    response.data.choices[0] &&
    response.data.choices[0].message &&
    response.data.choices[0].message.content
      ? response.data.choices[0].message.content
      : '';

  const cleaned = stripMarkdown(raw);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `Failed to parse OpenAI response as JSON: ${cleaned.substring(0, 200)}`
    );
  }

  const categoryId = parseInt(parsed.categoryId, 10);
  const confidence = parseFloat(parsed.confidence);

  if (!Number.isFinite(categoryId) || categoryId <= 0) {
    throw new Error(`Invalid categoryId in OpenAI response: ${parsed.categoryId}`);
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`Invalid confidence in OpenAI response: ${parsed.confidence}`);
  }

  const validIds = new Set(categories.map((c) => c.id));
  if (!validIds.has(categoryId)) {
    throw new Error(
      `OpenAI returned categoryId ${categoryId} which is not in the list of valid categories`
    );
  }

  return {
    categoryId,
    confidence,
    reasoning: parsed.reasoning || '',
  };
}

module.exports = { healthCheck, suggestCategory };
