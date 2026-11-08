/** Claude via the official Anthropic SDK, with structured JSON output. */
import Anthropic from '@anthropic-ai/sdk';
import { LlmRefusalError, type LlmClient, type LlmRequest } from './types';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

export function anthropicClient(opts: { model?: string; apiKey?: string } = {}): LlmClient {
  // Credentials: ANTHROPIC_API_KEY, or any source the SDK resolves (e.g. `ant auth login`).
  const client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  const model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;

  return {
    label: `anthropic/${model}`,
    async completeJson(req: LlmRequest): Promise<string> {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        // Security release notes can occasionally trip a safety classifier;
        // "default" fallbacks re-run a declined request on a suitable model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
          effort: 'medium',
          format: { type: 'json_schema', schema: req.schema },
        },
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      });

      if (response.stop_reason === 'refusal') {
        throw new LlmRefusalError(
          `Model declined (${response.stop_details?.category ?? 'no category'}); all fields stay unknown.`,
        );
      }
      if (response.stop_reason === 'max_tokens') {
        throw new Error('Model output hit max_tokens; try fewer documents (--max-chars).');
      }
      const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      if (!text) throw new Error('Model returned no text.');
      return text;
    },
  };
}
