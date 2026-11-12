/**
 * Adapter for non-Anthropic providers that expose an OpenAI-compatible
 * /chat/completions endpoint (Google Gemini, Groq, OpenRouter, a local Ollama…).
 * Used to try the pipeline on free tiers. Claude is always called through the
 * official SDK in anthropic.ts, never through this adapter.
 */
import { withRetry } from '../fetch/http';
import type { LlmClient, LlmRequest } from './types';

/** A 429 whose body names a daily quota: retrying today is pointless. */
export function isDailyQuotaError(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  return err?.status === 429 && /per ?day|PerDay|RPD/i.test(err.message ?? '');
}

/**
 * `model` may be a comma-separated list, best first
 * ("gemini-3.5-flash,gemini-3.5-flash-lite"). When a model's daily free quota
 * runs out (or it keeps answering 429), the rest of the run uses the next one.
 */
export function openAiCompatibleClient(opts: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Backoff between retries of one model (tests pass short ones). */
  retryDelaysMs?: number[];
}): LlmClient {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const host = new URL(url).host;
  const models = opts.model
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  if (!models.length) throw new Error('LLM_MODEL is empty.');
  let current = 0;

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

  const askOne = (model: string, messages: unknown[]) => {
    const base = { model, messages, temperature: 0 };
    // Free tiers often answer 429/503 under load: back off and retry, but not
    // when the daily quota is gone.
    return withRetry(
      async () => {
        try {
          return await call({ ...base, response_format: { type: 'json_object' } });
        } catch (e) {
          // Some providers reject response_format; retry once without it.
          if ((e as { status?: number }).status === 400) return call(base);
          if (isDailyQuotaError(e)) (e as { status?: number }).status = -429;
          throw e;
        }
      },
      opts.retryDelaysMs ?? [10_000, 30_000, 60_000],
    );
  };

  return {
    get label() {
      return `${host}/${models[current]}`;
    },
    async completeJson(req: LlmRequest): Promise<string> {
      // Not every provider enforces a schema, so it's also spelled out in the prompt.
      const messages = [
        { role: 'system', content: req.system },
        {
          role: 'user',
          content: `${req.user}\n\nReturn ONLY a JSON object matching this JSON Schema:\n${JSON.stringify(req.schema)}`,
        },
      ];
      for (;;) {
        try {
          return await askOne(models[current]!, messages);
        } catch (e) {
          const status = (e as { status?: number }).status;
          const outOfQuota = status === -429 || status === 429;
          if (!outOfQuota || current === models.length - 1) {
            if (status === -429) (e as { status?: number }).status = 429;
            throw e;
          }
          console.warn(
            `\n  ${models[current]} is out of quota; using ${models[current + 1]} from now on.`,
          );
          current++;
        }
      }
    },
  };
}
