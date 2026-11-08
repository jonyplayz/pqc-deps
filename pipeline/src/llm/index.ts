import { anthropicClient } from './anthropic';
import { openAiCompatibleClient } from './openai-compatible';
import type { LlmClient } from './types';

export * from './types';

/**
 * Pick the LLM from environment variables:
 *   LLM_PROVIDER=anthropic (default)  ANTHROPIC_API_KEY, optional LLM_MODEL
 *   LLM_PROVIDER=openai-compatible    LLM_BASE_URL, LLM_MODEL, optional LLM_API_KEY
 */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient {
  const provider = (env.LLM_PROVIDER ?? 'anthropic').toLowerCase();
  if (provider === 'anthropic') {
    return anthropicClient({
      ...(env.LLM_MODEL ? { model: env.LLM_MODEL } : {}),
      ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
    });
  }
  if (provider === 'openai-compatible' || provider === 'openai') {
    if (!env.LLM_BASE_URL || !env.LLM_MODEL) {
      throw new Error(
        'LLM_PROVIDER=openai-compatible needs LLM_BASE_URL and LLM_MODEL (see README).',
      );
    }
    return openAiCompatibleClient({
      baseUrl: env.LLM_BASE_URL,
      model: env.LLM_MODEL,
      ...(env.LLM_API_KEY ? { apiKey: env.LLM_API_KEY } : {}),
    });
  }
  throw new Error(
    `Unknown LLM_PROVIDER "${env.LLM_PROVIDER}". Use "anthropic" or "openai-compatible".`,
  );
}
