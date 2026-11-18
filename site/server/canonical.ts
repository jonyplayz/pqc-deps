// Canonical host: one public address for search engines, links and sign-in.
/** The public address. The project's own pages.dev name and www redirect here. */
export const CANONICAL_HOST = 'pqcdeps.com';
const REDIRECT_HOSTS = new Set(['pqc-deps.pages.dev', 'www.pqcdeps.com']);

/**
 * 301 to the canonical host for page loads. Only GET/HEAD: a POST (the
 * Telegram webhook, forms) must not be redirected, and preview deployments
 * (<hash>.pqc-deps.pages.dev) keep working on their own address.
 */
export function canonicalRedirect(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (!REDIRECT_HOSTS.has(url.hostname)) return undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
  url.hostname = CANONICAL_HOST;
  url.protocol = 'https:';
  url.port = '';
  return new Response(null, {
    status: 301,
    headers: { Location: url.toString(), 'Cache-Control': 'public, max-age=86400' },
  });
}
