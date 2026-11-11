// Security headers on every Functions response (site/public/_headers only
// covers static files). API responses get a locked-down CSP; the sign-in
// error page needs inline styles, so it sets its own.
import type { Env } from '../server/env';

const HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};

export const onRequest: PagesFunction<Env> = async ({ next }) => {
  const res = await next();
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(HEADERS)) {
    if (!out.headers.has(k)) out.headers.set(k, v);
  }
  return out;
};
