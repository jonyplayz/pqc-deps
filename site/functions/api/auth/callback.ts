import { finishLogin } from '../../../server/auth';
import type { Env } from '../../../server/env';
import { handle } from '../../../server/http';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const res = await handle(() => finishLogin(request, env));
  if (res.status < 400) return res;
  // Show login problems as a readable page instead of raw JSON.
  const { error } = (await res.json()) as { error: string };
  const safe = error.replace(/[<>&]/g, '');
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign-in problem</title><body style="font-family:system-ui;max-width:36rem;margin:3rem auto;padding:0 16px"><h1>Sign-in problem</h1><p>${safe}</p><p><a href="/admin">Back to the admin page</a></p></body>`,
    {
      status: res.status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // Inline style attributes only; no scripts.
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      },
    },
  );
};
