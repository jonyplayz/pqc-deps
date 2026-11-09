import { HttpError } from './http';
import type { Env } from './env';

/** Verify a Cloudflare Turnstile token from a public form. */
export async function verifyTurnstile(
  token: unknown,
  env: Env,
  ip: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!env.TURNSTILE_SECRET) throw new HttpError(503, 'Requests are not enabled yet.');
  if (typeof token !== 'string' || !token || token.length > 2048) {
    throw new HttpError(400, 'Please complete the "I am human" check.');
  }
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean };
  if (!data.success) {
    throw new HttpError(403, 'The "I am human" check failed. Reload the page and try again.');
  }
}
