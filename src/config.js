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

  // Ollama (local LLM)
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.2',
    timeoutMs: parseInt(process.env.OLLAMA_TIMEOUT_MS || '60000', 10),
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
