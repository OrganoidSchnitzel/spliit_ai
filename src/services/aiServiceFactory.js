'use strict';

/**
 * Factory that returns the correct AI service based on the AI_PROVIDER
 * environment variable. Follows the same pattern as paperless-ai.
 *
 * Supported providers:
 *   - 'ollama'  (default) – local Ollama instance
 *   - 'openai'            – OpenAI API or any OpenAI-compatible endpoint
 *                           (DeepSeek, LiteLLM, Fastchat, etc.)
 */

const config = require('../config');

class AIServiceFactory {
  static getService() {
    switch (config.aiProvider) {
      case 'openai':
        return require('./openaiService');
      case 'ollama':
      default:
        return require('./ollamaService');
    }
  }
}

module.exports = AIServiceFactory;
