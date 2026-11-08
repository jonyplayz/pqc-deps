/**
 * Adapter for non-Anthropic providers that expose an OpenAI-compatible
 * /chat/completions endpoint (Google Gemini, Groq, OpenRouter, a local Ollama…).
 * Used to try the pipeline on free tiers. Claude is always called through the
 * official SDK in anthropic.ts, never through this adapter.
 */
import type { LlmClient, LlmRequest } from './types';

export function openAiCompatibleClient(opts: {
  baseUrl: string;
  apiKey?: string;
  model: string;
}): LlmClient {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const host = new URL(url).host;

  const call = async (body: Record<string, unknown>) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${host} returned HTTP ${res.status}: ${text.slice(0, 500)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    const json = JSON.parse(text);
    const content: unknown = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim())
      throw new Error(`${host} returned an empty answer.`);
    return content;
  };

  return {
    label: `${host}/${opts.model}`,
    async completeJson(req: LlmRequest): Promise<string> {
      // Not every provider enforces a schema, so it's also spelled out in the prompt.
      const messages = [
        { role: 'system', content: req.system },
        {
          role: 'user',
          content: `${req.user}\n\nReturn ONLY a JSON object matching this JSON Schema:\n${JSON.stringify(req.schema)}`,
        },
      ];
      const base = { model: opts.model, messages, temperature: 0 };
      try {
        return await call({ ...base, response_format: { type: 'json_object' } });
      } catch (e) {
        // Some providers reject response_format; retry once without it.
        if ((e as { status?: number }).status === 400) return call(base);
        throw e;
      }
    },
  };
}
