'use strict';

const config = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),

  // PostgreSQL (Spliit database)
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    name: process.env.DB_NAME || 'spliit',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl: process.env.DB_SSL === 'true',
  },

  // AI provider – 'ollama' (default) or 'openai' (any OpenAI-compatible API)
  aiProvider: process.env.AI_PROVIDER || 'ollama',

  // Ollama
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.2',
    timeoutMs: parseInt(process.env.OLLAMA_TIMEOUT_MS || '60000', 10),
  },

  // OpenAI-compatible API (OpenAI, DeepSeek, LiteLLM, Fastchat, etc.)
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    timeoutMs: parseInt(process.env.OPENAI_TIMEOUT_MS || '60000', 10),
  },

  // Minimum confidence (0–1) to auto-apply a suggested category
  confidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.6'),

  // Scheduler
  scheduler: {
    enabled: process.env.SCHEDULER_ENABLED !== 'false',
    cronExpression: process.env.SCHEDULER_CRON || '*/15 * * * *',
  },

  // Processing
  processing: {
    batchSize: parseInt(process.env.BATCH_SIZE || '10', 10),
  },
};

module.exports = config;
